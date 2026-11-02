import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '../../generated/prisma/client';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { DealStatus } from '../../generated/prisma/client';
import { LockRequest } from '../../infrastructure/prisma/advisory-lock';
import { CompaniesService } from '../companies/companies.service';
import { ContactsService } from '../contacts/contacts.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { DealRecord, DealsRepository } from './deals.repository';
import { DealsService } from './deals.service';

const tx = { marker: 'tx' };
const repository = {
  inLocks: vi.fn(),
  findVisible: vi.fn(),
  moveStage: vi.fn(),
  recordStageChange: vi.fn(),
  findHistoryPage: vi.fn(),
};
const ownership = { resolve: vi.fn() };
const pipelines = { findStageInPipeline: vi.fn() };
const emitAsync = vi.fn();
const service = new DealsService(
  repository as unknown as DealsRepository,
  ownership as unknown as OwnershipScopeService,
  pipelines as unknown as PipelinesService,
  {} as CompaniesService,
  {} as ContactsService,
  {} as OrganizationsService,
  { emitAsync } as unknown as EventEmitter2,
);

const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: 'org',
  role: 'SALES_REP',
  permissions: [],
  mustChangePassword: false,
};
const scope: VisibilityScope = { kind: 'owners', ownerIds: ['me'] };
const deal = (overrides: Partial<DealRecord> = {}): DealRecord => ({
  id: 'd1',
  title: 'Globex licence',
  amount: new Prisma.Decimal('100'),
  currency: 'USD',
  expectedCloseDate: null,
  status: DealStatus.OPEN,
  lostReason: null,
  closedAt: null,
  pipelineId: 'p1',
  stageId: 's1',
  contactId: null,
  companyId: null,
  ownerId: 'me',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});
const stage = (id: string, kind?: 'won' | 'lost') => ({
  id,
  name: id,
  position: 1,
  probability: 0,
  isWon: kind === 'won',
  isLost: kind === 'lost',
});
const failure = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as HttpException;
  return { status: error.getStatus(), body: JSON.stringify(error.getResponse()) };
};
let locks: readonly LockRequest[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  locks = [];
  ownership.resolve.mockResolvedValue(scope);
  emitAsync.mockResolvedValue([]);
  repository.inLocks.mockImplementation(
    (requested: readonly LockRequest[], work: (t: unknown) => Promise<unknown>) => {
      locks = requested;
      return work(tx);
    },
  );
  repository.findVisible.mockResolvedValue(deal());
  pipelines.findStageInPipeline.mockResolvedValue(stage('s2'));
  repository.moveStage.mockImplementation((_tx, _scope, _id, _from, data: object) =>
    Promise.resolve(deal({ ...data })),
  );
});

describe('DealsService.move', () => {
  it('moves under the SHARED pipeline lock with a compare-and-set on the stage that was read', async () => {
    const moved = await service.move(actor, 'd1', { stageId: 's2' });
    expect(locks).toEqual([{ kind: 'pipeline', id: 'p1', mode: 'shared' }]);
    expect(pipelines.findStageInPipeline).toHaveBeenCalledWith(tx, 'p1', 's2');
    expect(repository.moveStage).toHaveBeenCalledWith(tx, scope, 'd1', 's1', {
      stageId: 's2',
      status: DealStatus.OPEN,
      closedAt: null,
      lostReason: null,
    });
    expect(moved.stageId).toBe('s2');
  });

  it('writes the history row (from, to, actor) only after the compare-and-set matched', async () => {
    await service.move(actor, 'd1', { stageId: 's2' });
    expect(repository.recordStageChange).toHaveBeenCalledWith(tx, {
      organizationId: 'org',
      dealId: 'd1',
      fromStageId: 's1',
      toStageId: 's2',
      changedById: 'me',
    });
  });

  it('a Lost stage needs a reason (400) and writes nothing', async () => {
    pipelines.findStageInPipeline.mockResolvedValue(stage('lost', 'lost'));
    const result = await failure(service.move(actor, 'd1', { stageId: 'lost' }));
    expect(result.status).toBe(400);
    expect(result.body).toContain('LOST_REASON_REQUIRED');
    expect(repository.moveStage).not.toHaveBeenCalled();
    expect(repository.recordStageChange).not.toHaveBeenCalled();
  });

  it('moving to the stage the deal is in is 409 INVALID_STAGE_MOVE without touching anything', async () => {
    const result = await failure(service.move(actor, 'd1', { stageId: 's1' }));
    expect(result.status).toBe(409);
    expect(result.body).toContain('INVALID_STAGE_MOVE');
    expect(repository.inLocks).not.toHaveBeenCalled();
  });

  it('404 when the deal is not visible', async () => {
    repository.findVisible.mockResolvedValue(null);
    expect((await failure(service.move(actor, 'd1', { stageId: 's2' }))).status).toBe(404);
  });

  it('a lost compare-and-set is 409 DEAL_STAGE_CHANGED: no history, no event', async () => {
    repository.moveStage.mockResolvedValue(null);
    repository.findVisible
      .mockResolvedValueOnce(deal())
      .mockResolvedValueOnce(deal({ stageId: 's3' }));
    const result = await failure(service.move(actor, 'd1', { stageId: 's2' }));
    expect(result.status).toBe(409);
    expect(result.body).toContain('DEAL_STAGE_CHANGED');
    expect(repository.recordStageChange).not.toHaveBeenCalled();
    expect(emitAsync).not.toHaveBeenCalled();
  });

  it('a stage outside the pipeline (400) propagates and nothing is emitted', async () => {
    pipelines.findStageInPipeline.mockRejectedValue(
      new HttpException({ code: 'INVALID_STAGE' }, 400),
    );
    expect((await failure(service.move(actor, 'd1', { stageId: 'other' }))).status).toBe(400);
    expect(emitAsync).not.toHaveBeenCalled();
  });

  it('emits deal.stage_changed after success with ids and the resulting status only', async () => {
    pipelines.findStageInPipeline.mockResolvedValue(stage('won', 'won'));
    await service.move(actor, 'd1', { stageId: 'won' });
    expect(emitAsync).toHaveBeenCalledTimes(1);
    const [name, payload] = emitAsync.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('deal.stage_changed');
    expect(Object.keys(payload).sort()).toEqual([
      'actorId',
      'changedAt',
      'dealId',
      'fromStageId',
      'organizationId',
      'pipelineId',
      'status',
      'toStageId',
    ]);
    expect(payload).toMatchObject({
      organizationId: 'org',
      dealId: 'd1',
      pipelineId: 'p1',
      fromStageId: 's1',
      toStageId: 'won',
      status: DealStatus.WON,
      actorId: 'me',
    });
  });

  it('a throwing or rejecting listener does not break the move', async () => {
    emitAsync.mockImplementationOnce(() => {
      throw new Error('sync listener');
    });
    await expect(service.move(actor, 'd1', { stageId: 's2' })).resolves.toMatchObject({
      stageId: 's2',
    });
    emitAsync.mockRejectedValueOnce(new Error('async listener'));
    repository.findVisible.mockResolvedValue(deal());
    await expect(service.move(actor, 'd1', { stageId: 's2' })).resolves.toMatchObject({
      stageId: 's2',
    });
  });
});

describe('DealsService.history', () => {
  it('404 when the deal is not visible, without reading the history', async () => {
    repository.findVisible.mockResolvedValue(null);
    const query = { page: 1, limit: 20, sortOrder: 'desc' as const };
    expect((await failure(service.history(actor, 'd1', query))).status).toBe(404);
    expect(repository.findHistoryPage).not.toHaveBeenCalled();
  });

  it('reads the page for a visible deal', async () => {
    const page = { data: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0 } };
    repository.findHistoryPage.mockResolvedValue(page);
    const query = { page: 1, limit: 20, sortOrder: 'desc' as const };
    await expect(service.history(actor, 'd1', query)).resolves.toBe(page);
    expect(repository.findHistoryPage).toHaveBeenCalledWith('d1', query);
  });
});
