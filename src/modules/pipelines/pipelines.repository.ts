import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import {
  TenantPrismaClient,
  TenantTransactionClient,
} from '../../common/tenant/tenant-scope.extension';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { inLocks } from '../../common/tenant/in-locks.util';
import { queryPage } from '../../common/utils/pagination.util';
import { Prisma } from '../../generated/prisma/client';
import { LockRequest } from '../../infrastructure/prisma/advisory-lock';
import { PRISMA_TENANT } from '../../infrastructure/prisma/prisma.constants';
import { ListPipelinesQueryDto } from './dto/list-pipelines-query.dto';
import { PIPELINE_SORT_FIELDS } from './pipelines.constants';

// An explicit select: the response shape is decided here, never by whatever the table gains later.
const stageSelect = {
  id: true,
  name: true,
  position: true,
  probability: true,
  isWon: true,
  isLost: true,
} satisfies Prisma.PipelineStageSelect;

const pipelineSelect = {
  id: true,
  name: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
  stages: { select: stageSelect, orderBy: { position: 'asc' } },
} satisfies Prisma.PipelineSelect;

export type StageRecord = Prisma.PipelineStageGetPayload<{ select: typeof stageSelect }>;
export type PipelineRecord = Prisma.PipelineGetPayload<{ select: typeof pipelineSelect }>;
export type PipelinesTx = TenantTransactionClient;

export interface NewStageRow {
  name: string;
  probability: number;
  position: number;
  isWon: boolean;
  isLost: boolean;
}

// Pipelines and stages are configuration shared by the whole organization: there is no owner and
// so no visibility filter. The tenant client alone keeps other organizations out.
@Injectable()
export class PipelinesRepository {
  constructor(
    @Inject(PRISMA_TENANT) private readonly prisma: TenantPrismaClient,
    private readonly tenant: TenantContextService,
  ) {}

  // Every write runs in a transaction that first takes the given locks, in the order listed (see
  // advisory-lock.ts): structure changes take the pipeline lock EXCLUSIVELY, which waits for the
  // deal writes that hold it shared.
  inLocks<T>(locks: readonly LockRequest[], work: (tx: PipelinesTx) => Promise<T>): Promise<T> {
    return inLocks(this.prisma, locks, work);
  }

  findPage(query: ListPipelinesQueryDto): Promise<PaginatedResponseDto<PipelineRecord>> {
    return queryPage(query, {
      where: {} satisfies Prisma.PipelineWhereInput,
      sortFields: PIPELINE_SORT_FIELDS,
      fallbackSort: 'name',
      find: (args) => this.prisma.pipeline.findMany({ ...args, select: pipelineSelect }),
      count: (where) => this.prisma.pipeline.count({ where }),
    });
  }

  findById(
    id: string,
    db: Pick<PipelinesTx, 'pipeline'> = this.prisma,
  ): Promise<PipelineRecord | null> {
    return db.pipeline.findUnique({ where: { id }, select: pipelineSelect });
  }

  // The id of the default pipeline (each organization has exactly one), or null.
  async findDefaultId(db: Pick<PipelinesTx, 'pipeline'> = this.prisma): Promise<string | null> {
    const pipeline = await db.pipeline.findFirst({
      where: { isDefault: true },
      select: { id: true },
    });
    return pipeline?.id ?? null;
  }

  countPipelines(db: Pick<PipelinesTx, 'pipeline'>): Promise<number> {
    return db.pipeline.count();
  }

  // Case-insensitive: "enterprise" and "Enterprise" are the same pipeline to a human. The database
  // unique index is case-sensitive and stays as the backstop.
  findNameClash(
    name: string,
    excludeId: string | undefined,
    db: Pick<PipelinesTx, 'pipeline'>,
  ): Promise<{ id: string } | null> {
    return db.pipeline.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, id: { not: excludeId } },
      select: { id: true },
    });
  }

  create(
    data: { organizationId: string; name: string; isDefault: boolean; stages: NewStageRow[] },
    db: Pick<PipelinesTx, 'pipeline'>,
  ): Promise<PipelineRecord> {
    const { stages, ...pipeline } = data;
    // organizationId comes from the parent through the composite FK (nested write).
    return db.pipeline.create({
      data: { ...pipeline, stages: { create: stages } },
      select: pipelineSelect,
    });
  }

  update(
    id: string,
    data: { name?: string; isDefault?: boolean },
    db: Pick<PipelinesTx, 'pipeline'>,
  ): Promise<PipelineRecord> {
    return db.pipeline.update({ where: { id }, data, select: pipelineSelect });
  }

  // The default switch is "unset the old one, then set the new one", in this order, so the partial
  // unique index (one default per organization) is never violated.
  async clearDefault(db: Pick<PipelinesTx, 'pipeline'>): Promise<void> {
    await db.pipeline.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  async deletePipeline(id: string, db: Pick<PipelinesTx, 'pipeline'>): Promise<void> {
    await db.pipeline.delete({ where: { id } });
  }

  // Deals of the pipeline, SOFT-DELETED ONES INCLUDED: they still hold the RESTRICT foreign key.
  countDeals(pipelineId: string, db: Pick<PipelinesTx, 'deal'>): Promise<number> {
    return this.tenant.withDeleted(() => db.deal.count({ where: { pipelineId } }));
  }

  // A stage is in use by any deal (deleted included) or any history row that names it.
  async isStageReferenced(
    stageId: string,
    db: Pick<PipelinesTx, 'deal' | 'dealStageHistory'>,
  ): Promise<boolean> {
    const [deals, history] = await this.tenant.withDeleted(() =>
      Promise.all([
        db.deal.count({ where: { stageId } }),
        db.dealStageHistory.count({
          where: { OR: [{ fromStageId: stageId }, { toStageId: stageId }] },
        }),
      ]),
    );
    return deals + history > 0;
  }

  listStages(pipelineId: string, db: Pick<PipelinesTx, 'pipelineStage'>): Promise<StageRecord[]> {
    return db.pipelineStage.findMany({
      where: { pipelineId },
      select: stageSelect,
      orderBy: { position: 'asc' },
    });
  }

  findStageNameClash(
    pipelineId: string,
    name: string,
    excludeStageId: string | undefined,
    db: Pick<PipelinesTx, 'pipelineStage'>,
  ): Promise<{ id: string } | null> {
    return db.pipelineStage.findFirst({
      where: {
        pipelineId,
        name: { equals: name, mode: 'insensitive' },
        id: { not: excludeStageId },
      },
      select: { id: true },
    });
  }

  createStage(
    organizationId: string,
    pipelineId: string,
    row: NewStageRow,
    db: Pick<PipelinesTx, 'pipelineStage'>,
  ): Promise<StageRecord> {
    return db.pipelineStage.create({
      data: { organizationId, pipelineId, ...row },
      select: stageSelect,
    });
  }

  updateStage(
    stageId: string,
    data: { name?: string; probability?: number },
    db: Pick<PipelinesTx, 'pipelineStage'>,
  ): Promise<StageRecord> {
    return db.pipelineStage.update({ where: { id: stageId }, data, select: stageSelect });
  }

  async deleteStage(stageId: string, db: Pick<PipelinesTx, 'pipelineStage'>): Promise<void> {
    await db.pipelineStage.delete({ where: { id: stageId } });
  }

  async writePositions(
    changes: readonly { id: string; position: number }[],
    db: Pick<PipelinesTx, 'pipelineStage'>,
  ): Promise<void> {
    for (const { id, position } of changes) {
      await db.pipelineStage.update({ where: { id }, data: { position } });
    }
  }
}
