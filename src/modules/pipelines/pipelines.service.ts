import { Injectable } from '@nestjs/common';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import {
  DEFAULT_PIPELINE_TEMPLATE,
  MAX_OPEN_STAGES,
  buildStageRows,
} from '../../common/policies/pipeline-policy';
import { assertHasChanges } from '../../common/utils/assert-has-changes.util';
import { isUniqueViolation } from '../../common/utils/prisma-error.util';
import { LockRequest } from '../../infrastructure/prisma/advisory-lock';
import {
  CreatePipelineDto,
  OpenStageInputDto,
  ReorderStagesDto,
  UpdatePipelineDto,
  UpdateStageDto,
} from './dto/pipeline-input.dto';
import { ListPipelinesQueryDto } from './dto/list-pipelines-query.dto';
import { boardOrder, positionChanges, splitStages } from './pipeline-layout';
import {
  invalidPipeline,
  invalidStage,
  invalidStageOrder,
  pipelineHasDeals,
  pipelineIsDefault,
  pipelineNameTaken,
  pipelineNeedsOpenStage,
  stageInUse,
  stageNameTaken,
  terminalProbabilityFixed,
  terminalStageRequired,
  tooManyStages,
} from './pipelines.exceptions';
import {
  PipelineRecord,
  PipelinesRepository,
  PipelinesTx,
  StageRecord,
} from './pipelines.repository';

// Locks (advisory-lock.ts, order org -> pipeline): anything that touches pipeline-level state (name,
// default, existence) takes the org lock; anything that changes stages takes the pipeline lock
// EXCLUSIVELY, so it waits for deal writes (which hold it shared) and holds new ones off. Both are
// admin-only and rare, so the contention with deal writes is accepted (ADR 0009).
@Injectable()
export class PipelinesService {
  constructor(private readonly repository: PipelinesRepository) {}

  list(query: ListPipelinesQueryDto): Promise<PaginatedResponseDto<PipelineRecord>> {
    return this.repository.findPage(query);
  }

  async get(id: string): Promise<PipelineRecord> {
    const pipeline = await this.repository.findById(id);
    if (!pipeline) throw resourceNotFound('Pipeline');
    return pipeline;
  }

  // For modules that place records in a pipeline (deals). The default pipeline is resolved BEFORE
  // the caller opens its transaction, because the caller needs the id to take the (shared) pipeline
  // lock; `resolvePlacement` then re-checks everything under that lock.
  async defaultPipelineId(): Promise<string> {
    const id = await this.repository.findDefaultId();
    if (!id) throw invalidPipeline();
    return id;
  }

  // Call it INSIDE the transaction that holds the pipeline lock (shared is enough: deal writes only
  // need the stages to stay as they are) and performs the write. The stage must belong to the
  // pipeline and be open: nothing is created directly in Won or Lost. Without a stage, the first
  // open stage. Every failure is the same 400 per field, so nothing is revealed about other records.
  async resolvePlacement(
    db: Pick<PipelinesTx, 'pipeline'>,
    pipelineId: string,
    stageId: string | undefined,
  ): Promise<{ pipelineId: string; stageId: string }> {
    const pipeline = await this.repository.findById(pipelineId, db);
    if (!pipeline) throw invalidPipeline();
    const { open } = splitStages(pipeline.stages);
    const stage = stageId ? open.find(({ id }) => id === stageId) : open[0];
    if (!stage) throw invalidStage();
    return { pipelineId, stageId: stage.id };
  }

  // The destination of a stage move: ANY stage (Won and Lost included) of the deal's own pipeline.
  // Call it inside the transaction that holds the pipeline lock. A stage of another pipeline or
  // organization, or one deleted meanwhile, is the same 400.
  async findStageInPipeline(
    db: Pick<PipelinesTx, 'pipeline'>,
    pipelineId: string,
    stageId: string,
  ): Promise<StageRecord> {
    const pipeline = await this.repository.findById(pipelineId, db);
    const stage = pipeline?.stages.find(({ id }) => id === stageId);
    if (!stage) throw invalidStage();
    return stage;
  }

  // Never the default unless the organization has no pipeline at all: switching the default is an
  // explicit PATCH.
  async create(actor: AuthenticatedUser, dto: CreatePipelineDto): Promise<PipelineRecord> {
    const stages = buildStageRows(dto.stages ?? DEFAULT_PIPELINE_TEMPLATE.openStages);
    if (hasDuplicateNames(stages)) throw stageNameTaken();

    return this.guardUnique(pipelineNameTaken, () =>
      this.repository.inLocks([this.orgLock(actor)], async (tx) => {
        if (await this.repository.findNameClash(dto.name, undefined, tx)) throw pipelineNameTaken();
        const isDefault = (await this.repository.countPipelines(tx)) === 0;
        return this.repository.create(
          { organizationId: actor.organizationId, name: dto.name, isDefault, stages },
          tx,
        );
      }),
    );
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdatePipelineDto,
  ): Promise<PipelineRecord> {
    assertHasChanges(dto);
    return this.guardUnique(pipelineNameTaken, () =>
      this.repository.inLocks([this.orgLock(actor)], async (tx) => {
        const current = await this.repository.findById(id, tx);
        if (!current) throw resourceNotFound('Pipeline');
        if (dto.name !== undefined && (await this.repository.findNameClash(dto.name, id, tx))) {
          throw pipelineNameTaken();
        }
        // Unset the old default BEFORE setting the new one, inside this one transaction under the
        // org lock: the partial unique index is never violated and no reader sees two defaults.
        if (dto.isDefault && !current.isDefault) await this.repository.clearDefault(tx);
        return this.repository.update(id, { name: dto.name, isDefault: dto.isDefault }, tx);
      }),
    );
  }

  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    await this.repository.inLocks([this.orgLock(actor), pipelineLock(id)], async (tx) => {
      const current = await this.repository.findById(id, tx);
      if (!current) throw resourceNotFound('Pipeline');
      if (current.isDefault) throw pipelineIsDefault();
      // Counted AFTER the exclusive lock: a deal placed in this pipeline holds the lock shared, so
      // it has either committed (and is counted here) or waits and then finds the pipeline gone.
      if ((await this.repository.countDeals(id, tx)) > 0) throw pipelineHasDeals();
      await this.repository.deletePipeline(id, tx);
    });
  }

  addStage(
    actor: AuthenticatedUser,
    pipelineId: string,
    dto: OpenStageInputDto,
  ): Promise<StageRecord> {
    return this.guardUnique(stageNameTaken, () =>
      this.inStructureLock(pipelineId, async (tx, stages) => {
        const { open, won, lost } = splitStages(stages);
        if (open.length >= MAX_OPEN_STAGES) throw tooManyStages();
        await this.assertStageNameFree(pipelineId, dto.name, undefined, tx);

        // The new stage goes after the last open stage; Won and Lost shift down by one, in this
        // same transaction.
        const created = await this.repository.createStage(
          actor.organizationId,
          pipelineId,
          { ...dto, position: open.length + 1, isWon: false, isLost: false },
          tx,
        );
        await this.repository.writePositions(
          positionChanges(boardOrder([...open, created], won, lost)),
          tx,
        );
        return created;
      }),
    );
  }

  async updateStage(
    pipelineId: string,
    stageId: string,
    dto: UpdateStageDto,
  ): Promise<StageRecord> {
    assertHasChanges(dto);
    return this.guardUnique(stageNameTaken, () =>
      this.inStructureLock(pipelineId, async (tx, stages) => {
        const stage = stages.find(({ id }) => id === stageId);
        if (!stage) throw resourceNotFound('Stage');
        if (dto.probability !== undefined && (stage.isWon || stage.isLost)) {
          throw terminalProbabilityFixed();
        }
        if (dto.name !== undefined) {
          await this.assertStageNameFree(pipelineId, dto.name, stageId, tx);
        }
        return this.repository.updateStage(stageId, dto, tx);
      }),
    );
  }

  async deleteStage(pipelineId: string, stageId: string): Promise<void> {
    await this.inStructureLock(pipelineId, async (tx, stages) => {
      const stage = stages.find(({ id }) => id === stageId);
      if (!stage) throw resourceNotFound('Stage');
      if (stage.isWon || stage.isLost) throw terminalStageRequired();
      const { open, won, lost } = splitStages(stages);
      if (open.length <= 1) throw pipelineNeedsOpenStage();
      // Checked after the exclusive lock, deleted deals included (RESTRICT foreign keys).
      if (await this.repository.isStageReferenced(stageId, tx)) throw stageInUse();

      await this.repository.deleteStage(stageId, tx);
      await this.repository.writePositions(
        positionChanges(
          boardOrder(
            open.filter(({ id }) => id !== stageId),
            won,
            lost,
          ),
        ),
        tx,
      );
    });
  }

  reorderStages(pipelineId: string, dto: ReorderStagesDto): Promise<PipelineRecord> {
    return this.inStructureLock(pipelineId, async (tx, stages) => {
      const { open, won, lost } = splitStages(stages);
      const byId = new Map(open.map((stage) => [stage.id, stage]));
      // dto.stageIds has no duplicates (validated), so equal length + all known ids = same set.
      const reordered = dto.stageIds.map((id) => byId.get(id));
      if (reordered.length !== open.length || reordered.some((stage) => !stage)) {
        throw invalidStageOrder();
      }
      await this.repository.writePositions(
        positionChanges(boardOrder(reordered as StageRecord[], won, lost)),
        tx,
      );
      return this.loadOrFail(pipelineId, tx);
    });
  }

  private orgLock(actor: AuthenticatedUser): LockRequest {
    return { kind: 'org', id: actor.organizationId };
  }

  // The exclusive pipeline lock, then the pipeline's stages (a missing pipeline is a 404, as is one
  // of another organization). `work` runs inside the transaction.
  private inStructureLock<T>(
    pipelineId: string,
    work: (tx: PipelinesTx, stages: StageRecord[]) => Promise<T>,
  ): Promise<T> {
    return this.repository.inLocks([pipelineLock(pipelineId)], async (tx) => {
      if (!(await this.repository.findById(pipelineId, tx))) throw resourceNotFound('Pipeline');
      return work(tx, await this.repository.listStages(pipelineId, tx));
    });
  }

  private async loadOrFail(id: string, tx: PipelinesTx): Promise<PipelineRecord> {
    const pipeline = await this.repository.findById(id, tx);
    if (!pipeline) throw resourceNotFound('Pipeline');
    return pipeline;
  }

  private async assertStageNameFree(
    pipelineId: string,
    name: string,
    excludeStageId: string | undefined,
    tx: PipelinesTx,
  ): Promise<void> {
    if (await this.repository.findStageNameClash(pipelineId, name, excludeStageId, tx)) {
      throw stageNameTaken();
    }
  }

  // The checks above run under a lock; the unique index is the backstop for anything that slips by.
  private async guardUnique<T>(taken: () => Error, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw isUniqueViolation(error) ? taken() : error;
    }
  }
}

const pipelineLock = (id: string): LockRequest => ({ kind: 'pipeline', id });

const hasDuplicateNames = (stages: readonly { name: string }[]): boolean =>
  new Set(stages.map(({ name }) => name.toLowerCase())).size !== stages.length;
