import { HttpException } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { LockRequest } from '../../infrastructure/prisma/advisory-lock';
import { PipelinesRepository, PipelineRecord, StageRecord } from './pipelines.repository';
import { PipelinesService } from './pipelines.service';

const tx = { marker: 'tx' };
const repository = {
  inLocks: vi.fn(),
  findPage: vi.fn(),
  findById: vi.fn(),
  countPipelines: vi.fn(),
  findNameClash: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  clearDefault: vi.fn(),
  deletePipeline: vi.fn(),
  countDeals: vi.fn(),
  isStageReferenced: vi.fn(),
  listStages: vi.fn(),
  findStageNameClash: vi.fn(),
  createStage: vi.fn(),
  updateStage: vi.fn(),
  deleteStage: vi.fn(),
  writePositions: vi.fn(),
};
const service = new PipelinesService(repository as unknown as PipelinesRepository);

const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: 'org',
  role: 'ADMIN',
  permissions: [],
  mustChangePassword: false,
};
const stage = (id: string, position: number, kind?: 'won' | 'lost'): StageRecord => ({
  id,
  name: id,
  position,
  probability: kind === 'won' ? 100 : 0,
  isWon: kind === 'won',
  isLost: kind === 'lost',
});
const stages = [stage('a', 1), stage('b', 2), stage('won', 3, 'won'), stage('lost', 4, 'lost')];
const pipeline = (overrides: Partial<PipelineRecord> = {}): PipelineRecord => ({
  id: 'p1',
  name: 'Sales',
  isDefault: false,
  stages,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});
const failure = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as HttpException;
  return { status: error.getStatus(), body: JSON.stringify(error.getResponse()) };
};
let locks: readonly LockRequest[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  repository.inLocks.mockImplementation(
    (requested: readonly LockRequest[], work: (t: unknown) => Promise<unknown>) => {
      locks = requested;
      return work(tx);
    },
  );
  repository.findById.mockResolvedValue(pipeline());
  repository.listStages.mockResolvedValue(stages);
  repository.countPipelines.mockResolvedValue(3);
  repository.create.mockImplementation((data: object) => Promise.resolve(data));
});

describe('PipelinesService', () => {
  describe('create', () => {
    it('copies the default template when no stages are sent, appending fixed Won and Lost', async () => {
      await service.create(actor, { name: 'Enterprise' });
      const data = repository.create.mock.calls[0]?.[0] as {
        organizationId: string;
        isDefault: boolean;
        stages: { name: string; probability: number; position: number }[];
      };
      expect(data.organizationId).toBe('org');
      expect(data.isDefault).toBe(false);
      expect(data.stages.map((s) => s.name)).toEqual([
        'Prospecting',
        'Qualified',
        'Proposal',
        'Negotiation',
        'Won',
        'Lost',
      ]);
      expect(data.stages.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(data.stages.slice(-2).map((s) => s.probability)).toEqual([100, 0]);
      expect(locks).toEqual([{ kind: 'org', id: 'org' }]);
    });

    it('only the first pipeline of an organization becomes the default', async () => {
      repository.countPipelines.mockResolvedValue(0);
      await service.create(actor, { name: 'First' });
      expect(repository.create.mock.calls[0]?.[0]).toMatchObject({ isDefault: true });
    });

    it('409 when a stage name repeats (also against Won / Lost, ignoring case)', async () => {
      const result = await failure(
        service.create(actor, { name: 'X', stages: [{ name: 'won', probability: 10 }] }),
      );
      expect(result.status).toBe(409);
      expect(result.body).toContain('STAGE_NAME_ALREADY_EXISTS');
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('409 PIPELINE_NAME_ALREADY_EXISTS on a clash', async () => {
      repository.findNameClash.mockResolvedValue({ id: 'other' });
      expect((await failure(service.create(actor, { name: 'Sales' }))).body).toContain(
        'PIPELINE_NAME_ALREADY_EXISTS',
      );
    });
  });

  describe('update', () => {
    it('400 EMPTY_UPDATE for an empty body', async () => {
      expect((await failure(service.update(actor, 'p1', {}))).body).toContain('EMPTY_UPDATE');
    });

    it('404 for a missing pipeline', async () => {
      repository.findById.mockResolvedValue(null);
      expect((await failure(service.update(actor, 'p1', { name: 'x' }))).status).toBe(404);
    });

    it('makes a pipeline the default by unsetting the old one FIRST, under the org lock', async () => {
      const order: string[] = [];
      repository.clearDefault.mockImplementation(() => order.push('clear'));
      repository.update.mockImplementation(() => order.push('set'));
      await service.update(actor, 'p1', { isDefault: true });
      expect(order).toEqual(['clear', 'set']);
      expect(locks).toEqual([{ kind: 'org', id: 'org' }]);
    });

    it('does not touch the default when the pipeline already is the default', async () => {
      repository.findById.mockResolvedValue(pipeline({ isDefault: true }));
      await service.update(actor, 'p1', { isDefault: true });
      expect(repository.clearDefault).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('takes the org lock, then the pipeline lock exclusively', async () => {
      repository.countDeals.mockResolvedValue(0);
      await service.delete(actor, 'p1');
      expect(locks).toEqual([
        { kind: 'org', id: 'org' },
        { kind: 'pipeline', id: 'p1' },
      ]);
      expect(repository.deletePipeline).toHaveBeenCalledWith('p1', tx);
    });

    it('409 PIPELINE_IS_DEFAULT, nothing deleted', async () => {
      repository.findById.mockResolvedValue(pipeline({ isDefault: true }));
      expect((await failure(service.delete(actor, 'p1'))).body).toContain('PIPELINE_IS_DEFAULT');
      expect(repository.deletePipeline).not.toHaveBeenCalled();
    });

    it('409 PIPELINE_HAS_DEALS when any deal (deleted included) is counted', async () => {
      repository.countDeals.mockResolvedValue(1);
      expect((await failure(service.delete(actor, 'p1'))).body).toContain('PIPELINE_HAS_DEALS');
      expect(repository.deletePipeline).not.toHaveBeenCalled();
    });
  });

  describe('stages', () => {
    it('adds an open stage before Won / Lost and shifts them in the same transaction', async () => {
      repository.findStageNameClash.mockResolvedValue(null);
      repository.createStage.mockResolvedValue(stage('c', 3));
      await service.addStage(actor, 'p1', { name: 'c', probability: 40 });
      expect(locks).toEqual([{ kind: 'pipeline', id: 'p1' }]);
      expect(repository.createStage).toHaveBeenCalledWith(
        'org',
        'p1',
        { name: 'c', probability: 40, position: 3, isWon: false, isLost: false },
        tx,
      );
      expect(repository.writePositions).toHaveBeenCalledWith(
        [
          { id: 'won', position: 4 },
          { id: 'lost', position: 5 },
        ],
        tx,
      );
    });

    it('400 TOO_MANY_STAGES past the limit', async () => {
      const many = Array.from({ length: 20 }, (_, i) => stage(`s${i}`, i + 1));
      repository.listStages.mockResolvedValue([...many, stage('won', 21, 'won')]);
      const result = await failure(service.addStage(actor, 'p1', { name: 'x', probability: 1 }));
      expect(result.status).toBe(400);
      expect(result.body).toContain('TOO_MANY_STAGES');
    });

    it('400 when the probability of Won or Lost is changed', async () => {
      const result = await failure(service.updateStage('p1', 'won', { probability: 90 }));
      expect(result.status).toBe(400);
      expect(result.body).toContain('TERMINAL_STAGE_PROBABILITY_FIXED');
    });

    it('a terminal stage can be renamed', async () => {
      repository.findStageNameClash.mockResolvedValue(null);
      repository.updateStage.mockResolvedValue(stage('won', 3, 'won'));
      await service.updateStage('p1', 'won', { name: 'Closed won' });
      expect(repository.updateStage).toHaveBeenCalledWith('won', { name: 'Closed won' }, tx);
    });

    it('404 for a stage of another pipeline', async () => {
      expect((await failure(service.updateStage('p1', 'nope', { name: 'x' }))).status).toBe(404);
    });

    it.each(['won', 'lost'])('409 TERMINAL_STAGE_REQUIRED when deleting %s', async (id) => {
      expect((await failure(service.deleteStage('p1', id))).body).toContain(
        'TERMINAL_STAGE_REQUIRED',
      );
    });

    it('409 PIPELINE_NEEDS_OPEN_STAGE for the last open stage', async () => {
      repository.listStages.mockResolvedValue([stage('a', 1), stage('won', 2, 'won')]);
      expect((await failure(service.deleteStage('p1', 'a'))).body).toContain(
        'PIPELINE_NEEDS_OPEN_STAGE',
      );
    });

    it('409 STAGE_IN_USE when deals or history reference the stage', async () => {
      repository.isStageReferenced.mockResolvedValue(true);
      expect((await failure(service.deleteStage('p1', 'a'))).body).toContain('STAGE_IN_USE');
      expect(repository.deleteStage).not.toHaveBeenCalled();
    });

    it('closes the position gap after deleting a stage', async () => {
      repository.isStageReferenced.mockResolvedValue(false);
      await service.deleteStage('p1', 'a');
      expect(repository.writePositions).toHaveBeenCalledWith(
        [
          { id: 'b', position: 1 },
          { id: 'won', position: 2 },
          { id: 'lost', position: 3 },
        ],
        tx,
      );
    });

    it('reorders the open stages and keeps Won / Lost last', async () => {
      await service.reorderStages('p1', { stageIds: ['b', 'a'] });
      expect(repository.writePositions).toHaveBeenCalledWith(
        [
          { id: 'b', position: 1 },
          { id: 'a', position: 2 },
        ],
        tx,
      );
    });

    it.each([[['a']], [['a', 'b', 'won']], [['a', 'zzz']]])(
      '400 INVALID_STAGE_ORDER for %j',
      async (stageIds) => {
        const result = await failure(service.reorderStages('p1', { stageIds }));
        expect(result.status).toBe(400);
        expect(result.body).toContain('INVALID_STAGE_ORDER');
        expect(repository.writePositions).not.toHaveBeenCalled();
      },
    );
  });
});
