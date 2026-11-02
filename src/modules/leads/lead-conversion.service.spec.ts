import { HttpException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { LeadSource, LeadStatus } from '../../generated/prisma/client';
import { CompaniesService } from '../companies/companies.service';
import { ContactsService } from '../contacts/contacts.service';
import { DealsService } from '../deals/deals.service';
import { LeadConversionService } from './lead-conversion.service';
import { LeadConversionSource, LeadRecord, LeadsRepository } from './leads.repository';

const repository = { findVisible: vi.fn(), convert: vi.fn() };
const ownership = { resolve: vi.fn(), resolveAssignableOwner: vi.fn() };
const contacts = { assertLinkable: vi.fn(), createWithin: vi.fn() };
const companies = { assertLinkable: vi.fn(), createWithin: vi.fn() };
const events = { emitAsync: vi.fn() };
const service = new LeadConversionService(
  repository as unknown as LeadsRepository,
  ownership as unknown as OwnershipScopeService,
  contacts as unknown as ContactsService,
  companies as unknown as CompaniesService,
  events as unknown as EventEmitter2,
  // These specs never send a deal; deal behaviour is covered in lead-conversion-deal.service.spec.ts.
  {} as DealsService,
);

const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: 'org',
  role: 'SALES_REP',
  permissions: ['leads:convert', 'contacts:create', 'companies:create'],
  mustChangePassword: false,
};
const scope: VisibilityScope = { kind: 'owners', ownerIds: ['me'] };
const tx = { marker: 'tx' };
const lead = (overrides: Partial<LeadRecord> = {}): LeadRecord => ({
  id: 'l1',
  firstName: 'Omar',
  lastName: 'Khaled',
  email: 'omar@globex.com',
  phone: '+20 100 123 4567',
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
const source = (overrides: Partial<LeadConversionSource> = {}): LeadConversionSource => ({
  ownerId: 'me',
  firstName: 'Omar',
  lastName: 'Khaled',
  email: 'omar@globex.com',
  phone: '+20 100 123 4567',
  companyName: 'Globex',
  ...overrides,
});
const failure = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as HttpException;
  return { status: error.getStatus(), body: JSON.stringify(error.getResponse()) };
};

// The repository mock runs the `work` the service hands it, with a fake transaction and the lead
// data the real claim would return, and answers like the real method.
function claimWith(claimed: LeadConversionSource): void {
  repository.convert.mockImplementation(
    async (
      _scope: unknown,
      _id: string,
      _from: LeadStatus,
      _link: unknown,
      work: (tx: unknown, lead: LeadConversionSource) => Promise<{ contactId: string }>,
    ) => {
      const outcome = await work(tx, claimed);
      return { lead: lead({ status: LeadStatus.CONVERTED, convertedAt: new Date(5) }), outcome };
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  ownership.resolve.mockResolvedValue(scope);
  repository.findVisible.mockResolvedValue(lead());
  events.emitAsync.mockResolvedValue([]);
  contacts.createWithin.mockImplementation((_db: unknown, data: { companyId?: string }) =>
    Promise.resolve({ id: 'c1', companyId: data.companyId ?? null }),
  );
  companies.createWithin.mockResolvedValue({ id: 'co1' });
  claimWith(source());
});

describe('LeadConversionService.convert', () => {
  describe('options and permissions', () => {
    it.each([
      [{ contactId: 'c', companyId: 'co' }],
      [{ contactId: 'c', createCompany: true }],
      [{ companyId: 'co', createCompany: true }],
    ])(
      '400 INVALID_CONVERSION_OPTIONS for contradictory options %j, nothing touched',
      async (dto) => {
        const result = await failure(service.convert(actor, 'l1', dto));
        expect(result.status).toBe(400);
        expect(result.body).toContain('INVALID_CONVERSION_OPTIONS');
        expect(repository.convert).not.toHaveBeenCalled();
      },
    );

    it('403 when a contact would be created without contacts:create', async () => {
      const rep = { ...actor, permissions: ['leads:convert'] };
      expect((await failure(service.convert(rep, 'l1', {}))).status).toBe(403);
      expect(repository.convert).not.toHaveBeenCalled();
    });

    it('linking an existing contact needs only leads:convert', async () => {
      contacts.assertLinkable.mockResolvedValue({ id: 'c9', companyId: null });
      const rep = { ...actor, permissions: ['leads:convert'] };
      await service.convert(rep, 'l1', { contactId: 'c9' });
      expect(contacts.createWithin).not.toHaveBeenCalled();
    });

    it('403 when createCompany lacks companies:create, even though contacts:create is held', async () => {
      const rep = { ...actor, permissions: ['leads:convert', 'contacts:create'] };
      expect((await failure(service.convert(rep, 'l1', { createCompany: true }))).status).toBe(403);
    });
  });

  describe('lead state', () => {
    it('404 when the lead is not visible or missing', async () => {
      repository.findVisible.mockResolvedValue(null);
      expect((await failure(service.convert(actor, 'l1', {}))).status).toBe(404);
    });

    it.each([LeadStatus.NEW, LeadStatus.CONTACTED, LeadStatus.UNQUALIFIED])(
      '409 INVALID_STATUS_TRANSITION for a %s lead (only QUALIFIED converts)',
      async (status) => {
        repository.findVisible.mockResolvedValue(lead({ status }));
        const result = await failure(service.convert(actor, 'l1', {}));
        expect(result.status).toBe(409);
        expect(result.body).toContain('INVALID_STATUS_TRANSITION');
        expect(repository.convert).not.toHaveBeenCalled();
      },
    );

    it('409 LEAD_ALREADY_CONVERTED for a converted lead', async () => {
      repository.findVisible.mockResolvedValue(lead({ status: LeadStatus.CONVERTED }));
      expect((await failure(service.convert(actor, 'l1', {}))).body).toContain(
        'LEAD_ALREADY_CONVERTED',
      );
    });

    it('409 when the claim loses a race (status changed meanwhile)', async () => {
      repository.convert.mockResolvedValue(null);
      repository.findVisible
        .mockResolvedValueOnce(lead())
        .mockResolvedValueOnce(lead({ status: LeadStatus.UNQUALIFIED }));
      const result = await failure(service.convert(actor, 'l1', {}));
      expect(result.status).toBe(409);
      expect(result.body).toContain('INVALID_STATUS_TRANSITION');
      expect(events.emitAsync).not.toHaveBeenCalled();
    });
  });

  describe('what is created', () => {
    it('builds the contact from the lead data read by the claim, owned by the lead owner', async () => {
      claimWith(source({ ownerId: 'me', firstName: 'Fresh' }));
      const result = await service.convert(actor, 'l1', {});
      expect(contacts.createWithin).toHaveBeenCalledWith(tx, {
        organizationId: 'org',
        ownerId: 'me',
        companyId: undefined,
        firstName: 'Fresh',
        lastName: 'Khaled',
        email: 'omar@globex.com',
        phone: '+20 100 123 4567',
      });
      expect(repository.convert).toHaveBeenCalledWith(
        scope,
        'l1',
        LeadStatus.QUALIFIED,
        undefined,
        expect.any(Function),
      );
      expect(result.createdCompany).toBeNull();
    });

    it('a manager converting a rep lead: the new contact belongs to the rep, resolved by the assignment rule', async () => {
      claimWith(source({ ownerId: 'rep' }));
      ownership.resolveAssignableOwner.mockResolvedValue('rep');
      await service.convert(actor, 'l1', {});
      expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'rep');
      expect(contacts.createWithin).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ ownerId: 'rep' }),
      );
    });

    it('createCompany creates a company named after the lead and puts the contact under it', async () => {
      const result = await service.convert(actor, 'l1', { createCompany: true });
      expect(companies.createWithin).toHaveBeenCalledWith(tx, {
        organizationId: 'org',
        ownerId: 'me',
        name: 'Globex',
      });
      expect(contacts.createWithin).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ companyId: 'co1' }),
      );
      expect(result.createdCompany).toEqual({ id: 'co1' });
    });

    it('400 when createCompany is asked for a lead without a company name (and nothing is created)', async () => {
      claimWith(source({ companyName: null }));
      const result = await failure(service.convert(actor, 'l1', { createCompany: true }));
      expect(result.status).toBe(400);
      expect(result.body).toContain('INVALID_CONVERSION_OPTIONS');
      expect(companies.createWithin).not.toHaveBeenCalled();
      expect(contacts.createWithin).not.toHaveBeenCalled();
      expect(events.emitAsync).not.toHaveBeenCalled();
    });

    it('companyId is checked inside the transaction, under the company lock, then used as is', async () => {
      await service.convert(actor, 'l1', { companyId: 'co7' });
      expect(repository.convert.mock.calls[0]?.[3]).toEqual({ kind: 'company', id: 'co7' });
      expect(companies.assertLinkable).toHaveBeenCalledWith(tx, scope, 'co7');
      expect(companies.createWithin).not.toHaveBeenCalled();
      expect(contacts.createWithin).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ companyId: 'co7' }),
      );
    });

    it('contactId links under the contact lock; the lead data is not applied to it', async () => {
      contacts.assertLinkable.mockResolvedValue({ id: 'c9', companyId: 'co5' });
      const result = await service.convert(actor, 'l1', { contactId: 'c9' });
      expect(repository.convert.mock.calls[0]?.[3]).toEqual({ kind: 'contact', id: 'c9' });
      expect(contacts.assertLinkable).toHaveBeenCalledWith(tx, scope, 'c9');
      expect(contacts.createWithin).not.toHaveBeenCalled();
      expect(companies.createWithin).not.toHaveBeenCalled();
      expect(result.contact).toEqual({ id: 'c9', companyId: 'co5' });
    });

    it('a failing link (INVALID_CONTACT) propagates and nothing is emitted', async () => {
      contacts.assertLinkable.mockRejectedValue(
        new HttpException({ code: 'INVALID_CONTACT' }, 400),
      );
      expect((await failure(service.convert(actor, 'l1', { contactId: 'c9' }))).status).toBe(400);
      expect(events.emitAsync).not.toHaveBeenCalled();
    });
  });

  describe('lead.converted event', () => {
    it('is emitted once after success with ids and the tenant only (no personal data)', async () => {
      await service.convert(actor, 'l1', { createCompany: true });
      expect(events.emitAsync).toHaveBeenCalledTimes(1);
      const [name, payload] = events.emitAsync.mock.calls[0] as [string, Record<string, unknown>];
      expect(name).toBe('lead.converted');
      expect(Object.keys(payload).sort()).toEqual([
        'actorId',
        'companyId',
        'contactId',
        'convertedAt',
        'dealId',
        'leadId',
        'organizationId',
        'ownerId',
      ]);
      expect(payload).toMatchObject({
        organizationId: 'org',
        leadId: 'l1',
        contactId: 'c1',
        companyId: 'co1',
        dealId: null,
        actorId: 'me',
      });
      expect(JSON.stringify(payload)).not.toMatch(/Omar|Khaled|globex|\+20/i);
    });

    it('is not emitted when the transaction fails', async () => {
      repository.convert.mockRejectedValue(new Error('boom'));
      await expect(service.convert(actor, 'l1', {})).rejects.toThrow('boom');
      expect(events.emitAsync).not.toHaveBeenCalled();
    });

    it('a synchronously throwing emitter does not break the response', async () => {
      events.emitAsync.mockImplementation(() => {
        throw new Error('listener exploded');
      });
      await expect(service.convert(actor, 'l1', {})).resolves.toMatchObject({
        contact: { id: 'c1' },
      });
    });

    it('a rejecting listener does not break the response (and is not an unhandled rejection)', async () => {
      events.emitAsync.mockRejectedValue(new Error('async listener failed'));
      await expect(service.convert(actor, 'l1', {})).resolves.toMatchObject({
        contact: { id: 'c1' },
      });
    });
  });
});
