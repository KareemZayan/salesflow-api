import { HttpException, Logger } from '@nestjs/common';
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
  findPage: vi.fn(),
  findVisible: vi.fn(),
  createWithin: vi.fn(),
  updateOpenVisible: vi.fn(),
  deleteVisible: vi.fn(),
};
const ownership = { resolve: vi.fn(), resolveAssignableOwner: vi.fn() };
const pipelines = { defaultPipelineId: vi.fn(), resolvePlacement: vi.fn() };
const companies = { assertLinkable: vi.fn() };
const contacts = { assertLinkable: vi.fn() };
const organizations = { getCurrent: vi.fn() };
const emitAsync = vi.fn();
const service = new DealsService(
  repository as unknown as DealsRepository,
  ownership as unknown as OwnershipScopeService,
  pipelines as unknown as PipelinesService,
  companies as unknown as CompaniesService,
  contacts as unknown as ContactsService,
  organizations as unknown as OrganizationsService,
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
  amount: new Prisma.Decimal('1250.5'),
  currency: 'USD',
  expectedCloseDate: new Date('2026-12-31T00:00:00.000Z'),
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
const failure = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as HttpException;
  return { status: error.getStatus(), body: JSON.stringify(error.getResponse()) };
};
let locks: readonly LockRequest[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  locks = [];
  ownership.resolve.mockResolvedValue(scope);
  organizations.getCurrent.mockResolvedValue({ defaultCurrency: 'EGP' });
  pipelines.defaultPipelineId.mockResolvedValue('p1');
  pipelines.resolvePlacement.mockResolvedValue({ pipelineId: 'p1', stageId: 's1' });
  repository.inLocks.mockImplementation(
    (requested: readonly LockRequest[], work: (t: unknown) => Promise<unknown>) => {
      locks = requested;
      return work(tx);
    },
  );
  repository.createWithin.mockResolvedValue(deal());
  repository.findVisible.mockResolvedValue(deal());
  repository.updateOpenVisible.mockResolvedValue(deal());
});

describe('DealsService.create', () => {
  it('defaults pipeline, stage, currency and amount, and owns the deal itself', async () => {
    await service.create(actor, { title: 'Big deal' });
    expect(pipelines.defaultPipelineId).toHaveBeenCalled();
    expect(pipelines.resolvePlacement).toHaveBeenCalledWith(tx, 'p1', undefined);
    expect(repository.createWithin).toHaveBeenCalledWith(
      tx,
      {
        organizationId: 'org',
        ownerId: 'me',
        pipelineId: 'p1',
        stageId: 's1',
        contactId: undefined,
        companyId: undefined,
        title: 'Big deal',
        amount: '0.00',
        currency: 'EGP',
        expectedCloseDate: null,
      },
      'me',
    );
  });

  it('does not ask for the organization currency when one is given', async () => {
    await service.create(actor, { title: 'x', currency: 'EUR', amount: '10.5' });
    expect(organizations.getCurrent).not.toHaveBeenCalled();
    expect(repository.createWithin.mock.calls[0]?.[1]).toMatchObject({
      currency: 'EUR',
      amount: '10.5',
    });
  });

  it('takes SHARED locks in the order pipeline, company, contact and checks the links inside', async () => {
    await service.create(actor, { title: 'x', companyId: 'co1', contactId: 'ct1' });
    expect(locks).toEqual([
      { kind: 'pipeline', id: 'p1', mode: 'shared' },
      { kind: 'company', id: 'co1', mode: 'shared' },
      { kind: 'contact', id: 'ct1', mode: 'shared' },
    ]);
    expect(companies.assertLinkable).toHaveBeenCalledWith(tx, scope, 'co1');
    expect(contacts.assertLinkable).toHaveBeenCalledWith(tx, scope, 'ct1');
  });

  it('locks only the pipeline when nothing is linked', async () => {
    await service.create(actor, { title: 'x', pipelineId: 'p9' });
    expect(locks).toEqual([{ kind: 'pipeline', id: 'p9', mode: 'shared' }]);
    expect(pipelines.defaultPipelineId).not.toHaveBeenCalled();
  });

  it('a failing link propagates and nothing is created', async () => {
    contacts.assertLinkable.mockRejectedValue(new HttpException({ code: 'INVALID_CONTACT' }, 400));
    expect((await failure(service.create(actor, { title: 'x', contactId: 'ct1' }))).status).toBe(
      400,
    );
    expect(repository.createWithin).not.toHaveBeenCalled();
  });

  it('answers amount as a 2-decimal string and the close date as YYYY-MM-DD', async () => {
    const created = await service.create(actor, { title: 'x' });
    expect(created.amount).toBe('1250.50');
    expect(created.expectedCloseDate).toBe('2026-12-31');
  });
});

describe('DealsService.update', () => {
  it('400 EMPTY_UPDATE for an empty body', async () => {
    expect((await failure(service.update(actor, 'd1', {}))).body).toContain('EMPTY_UPDATE');
  });

  it('a plain edit needs no lock, no transaction and no read', async () => {
    await service.update(actor, 'd1', { title: 'Renamed' });
    expect(repository.inLocks).not.toHaveBeenCalled();
    expect(repository.findVisible).not.toHaveBeenCalled();
    expect(repository.updateOpenVisible).toHaveBeenCalledWith(scope, 'd1', { title: 'Renamed' });
  });

  it('409 DEAL_CLOSED for a closed deal, whatever the edit', async () => {
    repository.findVisible.mockResolvedValue(deal({ status: DealStatus.WON }));
    const result = await failure(service.update(actor, 'd1', { amount: '5' }));
    expect(result.status).toBe(409);
    expect(result.body).toContain('DEAL_CLOSED');
    expect(repository.updateOpenVisible).not.toHaveBeenCalled();
  });

  it('404 when the deal is not visible; 409 only when a visible deal turned out closed', async () => {
    repository.findVisible.mockResolvedValue(null);
    expect((await failure(service.update(actor, 'd1', { amount: '5' }))).status).toBe(404);

    vi.resetAllMocks();
    ownership.resolve.mockResolvedValue(scope);
    repository.updateOpenVisible.mockResolvedValue(null);
    repository.findVisible.mockResolvedValue(deal({ status: DealStatus.LOST }));
    expect((await failure(service.update(actor, 'd1', { title: 'x' }))).body).toContain(
      'DEAL_CLOSED',
    );
    repository.findVisible.mockResolvedValue(null);
    expect((await failure(service.update(actor, 'd1', { title: 'x' }))).status).toBe(404);
  });

  it('checks and locks (shared) only a link that changed', async () => {
    repository.findVisible.mockResolvedValue(deal({ companyId: 'co1', contactId: null }));
    await service.update(actor, 'd1', { companyId: 'co1', contactId: 'ct2' });
    expect(locks).toEqual([{ kind: 'contact', id: 'ct2', mode: 'shared' }]);
    expect(companies.assertLinkable).not.toHaveBeenCalled();
    expect(contacts.assertLinkable).toHaveBeenCalledWith(tx, scope, 'ct2');
  });

  it('null unlinks without any lock or check', async () => {
    repository.findVisible.mockResolvedValue(deal({ companyId: 'co1' }));
    await service.update(actor, 'd1', { companyId: null, contactId: null });
    expect(repository.inLocks).not.toHaveBeenCalled();
    expect(repository.updateOpenVisible.mock.calls[0]?.[2]).toMatchObject({
      companyId: null,
      contactId: null,
    });
  });

  it('logs amount and currency changes with old and new values, ids only', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    repository.updateOpenVisible.mockResolvedValue(
      deal({ amount: new Prisma.Decimal('2000'), currency: 'EUR' }),
    );
    await service.update(actor, 'd1', { amount: '2000', currency: 'EUR' });
    expect(log).toHaveBeenCalledWith({
      event: 'deal.money_changed',
      organizationId: 'org',
      dealId: 'd1',
      actorId: 'me',
      amount: { from: '1250.50', to: '2000.00' },
      currency: { from: 'USD', to: 'EUR' },
    });
    log.mockRestore();
  });

  it('does not log when the values did not change', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await service.update(actor, 'd1', { amount: '1250.50' });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('DealsService.delete', () => {
  it('404 when nothing visible was deleted', async () => {
    repository.deleteVisible.mockResolvedValue(false);
    expect((await failure(service.delete(actor, 'd1'))).status).toBe(404);
  });

  it('resolves when a visible deal was deleted', async () => {
    repository.deleteVisible.mockResolvedValue(true);
    await expect(service.delete(actor, 'd1')).resolves.toBeUndefined();
  });
});
