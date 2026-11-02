import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '../../generated/prisma/client';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { DealStatus, LeadSource, LeadStatus } from '../../generated/prisma/client';
import { CompaniesService } from '../companies/companies.service';
import { ContactsService } from '../contacts/contacts.service';
import { DealRecord } from '../deals/deals.repository';
import { DealsService } from '../deals/deals.service';
import { LeadConversionService } from './lead-conversion.service';
import { LeadConversionSource, LeadRecord, LeadsRepository } from './leads.repository';

const tx = { marker: 'tx' };
const repository = { findVisible: vi.fn(), convert: vi.fn() };
const ownership = { resolve: vi.fn(), resolveAssignableOwner: vi.fn() };
const contacts = { assertLinkable: vi.fn(), createWithin: vi.fn() };
const companies = { assertLinkable: vi.fn(), createWithin: vi.fn() };
const deals = { resolveDefaults: vi.fn(), createWithin: vi.fn() };
const emitAsync = vi.fn();
const service = new LeadConversionService(
  repository as unknown as LeadsRepository,
  ownership as unknown as OwnershipScopeService,
  contacts as unknown as ContactsService,
  companies as unknown as CompaniesService,
  { emitAsync } as unknown as EventEmitter2,
  deals as unknown as DealsService,
);

const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: 'org',
  role: 'SALES_REP',
  permissions: ['leads:convert', 'contacts:create', 'companies:create', 'deals:create'],
  mustChangePassword: false,
};
const scope: VisibilityScope = { kind: 'owners', ownerIds: ['me'] };
const lead = (overrides: Partial<LeadRecord> = {}): LeadRecord => ({
  id: 'l1',
  firstName: 'Omar',
  lastName: 'Khaled',
  email: 'omar@globex.com',
  phone: null,
  companyName: 'Globex',
  source: LeadSource.WEBSITE,
  status: LeadStatus.QUALIFIED,
  score: 77,
  notes: null,
  ownerId: 'me',
  convertedAt: null,
  convertedContactId: null,
  convertedDealId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});
const claimed: LeadConversionSource = {
  ownerId: 'rep',
  firstName: 'Omar',
  lastName: 'Khaled',
  email: 'omar@globex.com',
  phone: null,
  companyName: 'Globex',
};
const dealRecord = (): DealRecord => ({
  id: 'd1',
  title: 'Globex licence',
  amount: new Prisma.Decimal('500'),
  currency: 'EGP',
  expectedCloseDate: null,
  status: DealStatus.OPEN,
  lostReason: null,
  closedAt: null,
  pipelineId: 'p1',
  stageId: 's1',
  contactId: 'c1',
  companyId: 'co1',
  ownerId: 'rep',
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
const failure = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as HttpException;
  return { status: error.getStatus(), body: JSON.stringify(error.getResponse()) };
};

beforeEach(() => {
  vi.resetAllMocks();
  ownership.resolve.mockResolvedValue(scope);
  ownership.resolveAssignableOwner.mockResolvedValue('rep');
  emitAsync.mockResolvedValue([]);
  repository.findVisible.mockResolvedValue(lead());
  repository.convert.mockImplementation(
    async (
      _scope: unknown,
      _id: string,
      _from: LeadStatus,
      _link: unknown,
      work: (
        t: unknown,
        l: LeadConversionSource,
      ) => Promise<{ contactId: string; dealId?: string | null }>,
    ) => {
      const outcome = await work(tx, claimed);
      return {
        lead: lead({
          status: LeadStatus.CONVERTED,
          convertedAt: new Date(5),
          convertedDealId: outcome.dealId ?? null,
        }),
        outcome,
      };
    },
  );
  contacts.createWithin.mockResolvedValue({ id: 'c1', companyId: 'co1' });
  deals.resolveDefaults.mockResolvedValue({ currency: 'EGP', pipelineId: 'p1' });
  deals.createWithin.mockResolvedValue(dealRecord());
});

describe('LeadConversionService.convert with a deal', () => {
  it('resolves the pipeline BEFORE the transaction and hands it to the repository for the shared lock', async () => {
    await service.convert(actor, 'l1', { deal: { title: 'Globex licence', amount: '500' } });
    expect(deals.resolveDefaults).toHaveBeenCalledWith(actor, {
      title: 'Globex licence',
      amount: '500',
    });
    expect(repository.convert).toHaveBeenCalledWith(
      scope,
      'l1',
      LeadStatus.QUALIFIED,
      undefined,
      expect.any(Function),
      { pipelineId: 'p1' },
    );
  });

  it('creates the deal inside the transaction, linked to the new contact and its company, owned by the lead owner', async () => {
    const result = await service.convert(actor, 'l1', {
      deal: {
        title: 'Globex licence',
        amount: '500',
        stageId: 's2',
        expectedCloseDate: '2027-01-01',
      },
    });
    expect(deals.createWithin).toHaveBeenCalledWith(tx, {
      organizationId: 'org',
      actorId: 'me',
      ownerId: 'rep',
      title: 'Globex licence',
      amount: '500',
      currency: 'EGP',
      pipelineId: 'p1',
      stageId: 's2',
      contactId: 'c1',
      companyId: 'co1',
      expectedCloseDate: '2027-01-01',
    });
    expect(result.deal).toMatchObject({ id: 'd1', amount: '500.00', currency: 'EGP' });
    expect(result.lead.convertedDealId).toBe('d1');
  });

  it('works with an existing contact too: the deal takes the company that contact has', async () => {
    contacts.assertLinkable.mockResolvedValue({ id: 'c9', companyId: 'co9' });
    await service.convert(actor, 'l1', { contactId: 'c9', deal: { title: 'x' } });
    expect(contacts.createWithin).not.toHaveBeenCalled();
    expect(deals.createWithin).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ contactId: 'c9', companyId: 'co9', ownerId: 'rep' }),
    );
  });

  it('puts the deal id in the event', async () => {
    await service.convert(actor, 'l1', { deal: { title: 'x' } });
    expect(emitAsync.mock.calls[0]?.[1]).toMatchObject({ contactId: 'c1', dealId: 'd1' });
  });

  it('without a deal nothing about deals is touched and the response says so', async () => {
    const result = await service.convert(actor, 'l1', {});
    expect(deals.resolveDefaults).not.toHaveBeenCalled();
    expect(deals.createWithin).not.toHaveBeenCalled();
    expect(repository.convert.mock.calls[0]).toHaveLength(5);
    expect(result.deal).toBeNull();
    expect(emitAsync.mock.calls[0]?.[1]).toMatchObject({ dealId: null });
  });

  it('403 without deals:create when a deal is requested, but not otherwise', async () => {
    const noDeals = { ...actor, permissions: ['leads:convert', 'contacts:create'] };
    expect((await failure(service.convert(noDeals, 'l1', { deal: { title: 'x' } }))).status).toBe(
      403,
    );
    expect(repository.convert).not.toHaveBeenCalled();
    await expect(service.convert(noDeals, 'l1', {})).resolves.toBeDefined();
  });

  it('linking an existing contact with a deal needs leads:convert and deals:create only', async () => {
    contacts.assertLinkable.mockResolvedValue({ id: 'c9', companyId: null });
    const minimal = { ...actor, permissions: ['leads:convert', 'deals:create'] };
    await expect(
      service.convert(minimal, 'l1', { contactId: 'c9', deal: { title: 'x' } }),
    ).resolves.toBeDefined();
  });

  it('an invalid pipeline or stage (400) propagates: nothing returned, no event', async () => {
    deals.createWithin.mockRejectedValue(new HttpException({ code: 'INVALID_STAGE' }, 400));
    const result = await failure(service.convert(actor, 'l1', { deal: { title: 'x' } }));
    expect(result.status).toBe(400);
    expect(result.body).toContain('INVALID_STAGE');
    expect(emitAsync).not.toHaveBeenCalled();
  });

  it('a missing default pipeline fails before the transaction', async () => {
    deals.resolveDefaults.mockRejectedValue(new HttpException({ code: 'INVALID_PIPELINE' }, 400));
    expect((await failure(service.convert(actor, 'l1', { deal: { title: 'x' } }))).status).toBe(
      400,
    );
    expect(repository.convert).not.toHaveBeenCalled();
  });
});
