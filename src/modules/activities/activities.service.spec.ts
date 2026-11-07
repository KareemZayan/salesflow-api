import { HttpException } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { encodeKeysetCursor } from '../../common/utils/keyset-cursor.util';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { ActivityType } from '../../generated/prisma/client';
import { CompaniesService } from '../companies/companies.service';
import { ContactsService } from '../contacts/contacts.service';
import { DealsService } from '../deals/deals.service';
import { LeadsService } from '../leads/leads.service';
import { ActivitiesRepository, ActivityRecord } from './activities.repository';
import { ActivitiesService } from './activities.service';

const repository = {
  findPage: vi.fn(),
  findOne: vi.fn(),
  createManual: vi.fn(),
  deleteManual: vi.fn(),
  createIfAbsent: vi.fn(),
};
const ownership = { resolve: vi.fn() };
const leads = { get: vi.fn() };
const deals = { get: vi.fn(), visibleIds: vi.fn() };
const contacts = { get: vi.fn() };
const companies = { get: vi.fn() };
const service = new ActivitiesService(
  repository as unknown as ActivitiesRepository,
  ownership as unknown as OwnershipScopeService,
  leads as unknown as LeadsService,
  deals as unknown as DealsService,
  contacts as unknown as ContactsService,
  companies as unknown as CompaniesService,
);

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: ORG,
  role: 'SALES_REP',
  permissions: [],
  mustChangePassword: false,
};
const row = (overrides: Partial<ActivityRecord> = {}): ActivityRecord => ({
  id: ID,
  type: ActivityType.NOTE,
  subject: 'Called',
  body: null,
  metadata: null,
  occurredAt: new Date('2026-11-07T10:00:00.000Z'),
  actorId: 'me',
  leadId: 'lead',
  dealId: null,
  contactId: null,
  companyId: null,
  createdAt: new Date('2026-11-07T10:00:00.000Z'),
  ...overrides,
});
const query = { limit: 20 };
const statusOf = async (promise: Promise<unknown>) =>
  ((await promise.catch((e: unknown) => e)) as HttpException).getStatus();
const codeOf = async (promise: Promise<unknown>) =>
  ((await promise.catch((e: unknown) => e)) as HttpException).getResponse() as { code: string };

beforeEach(() => {
  vi.resetAllMocks();
  ownership.resolve.mockResolvedValue({ kind: 'owners', ownerIds: ['me'] });
  leads.get.mockResolvedValue({});
  contacts.get.mockResolvedValue({});
  companies.get.mockResolvedValue({});
  deals.get.mockResolvedValue({});
  deals.visibleIds.mockResolvedValue(new Set());
  repository.findPage.mockResolvedValue([]);
});

describe('ActivitiesService.list: the parent comes first', () => {
  it.each([
    ['lead', leads],
    ['deal', deals],
    ['contact', contacts],
    ['company', companies],
  ] as const)('a hidden %s answers 404 and no activity query runs', async (kind, parentService) => {
    parentService.get.mockRejectedValue(resourceNotFound(kind));
    expect(await statusOf(service.list(actor, { kind, id: 'x' }, query))).toBe(404);
    expect(repository.findPage).not.toHaveBeenCalled();
  });

  it('a hidden parent is 404 even with a malformed cursor (the parent is judged first)', async () => {
    leads.get.mockRejectedValue(resourceNotFound('Lead'));
    expect(
      await statusOf(service.list(actor, { kind: 'lead', id: 'x' }, { limit: 20, cursor: '%%' })),
    ).toBe(404);
    expect(repository.findPage).not.toHaveBeenCalled();
  });

  it('asks the repository for limit + 1 rows and returns limit', async () => {
    repository.findPage.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    const page = await service.list(actor, { kind: 'lead', id: 'lead' }, { limit: 2 });
    expect(repository.findPage).toHaveBeenCalledWith({ kind: 'lead', id: 'lead' }, undefined, 3);
    expect(page.data).toHaveLength(2);
    expect(page.meta.nextCursor).toEqual(expect.any(String));
  });

  it('nextCursor is null on the last page', async () => {
    repository.findPage.mockResolvedValue([row()]);
    expect(
      (await service.list(actor, { kind: 'lead', id: 'lead' }, query)).meta.nextCursor,
    ).toBeNull();
  });

  it('a cursor of another organization or a tampered one is 400 INVALID_CURSOR', async () => {
    const foreign = encodeKeysetCursor('22222222-2222-4222-8222-222222222222', {
      at: new Date(),
      id: ID,
    });
    for (const cursor of [foreign, 'not-a-cursor']) {
      const failed = service.list(actor, { kind: 'lead', id: 'lead' }, { limit: 20, cursor });
      expect(await statusOf(failed)).toBe(400);
      expect(
        (await codeOf(service.list(actor, { kind: 'lead', id: 'lead' }, { limit: 20, cursor })))
          .code,
      ).toBe('INVALID_CURSOR');
    }
    expect(repository.findPage).not.toHaveBeenCalled();
  });

  it('passes a valid cursor to the repository as a position', async () => {
    const at = new Date('2026-11-07T09:00:00.000Z');
    const cursor = encodeKeysetCursor(ORG, { at, id: ID });
    await service.list(actor, { kind: 'lead', id: 'lead' }, { limit: 20, cursor });
    expect(repository.findPage).toHaveBeenCalledWith(
      { kind: 'lead', id: 'lead' },
      { at, id: ID },
      21,
    );
  });
});

describe('ActivitiesService.list: deal data on another record timeline', () => {
  const stageEntry = row({
    id: 'e1',
    type: ActivityType.STAGE_CHANGE,
    leadId: null,
    contactId: 'contact',
    metadata: {
      kind: 'deal.stage_changed',
      deal: { dealId: 'deal-1', fromStageId: 's1', toStageId: 's2', status: 'OPEN' },
    },
  });

  it('keeps the deal data for a deal the caller can see', async () => {
    repository.findPage.mockResolvedValue([stageEntry]);
    deals.visibleIds.mockResolvedValue(new Set(['deal-1']));
    const { data } = await service.list(actor, { kind: 'contact', id: 'contact' }, query);
    expect(data[0].metadata).toHaveProperty('deal.toStageId', 's2');
  });

  it('removes id, stages and status for a deal the caller cannot see', async () => {
    repository.findPage.mockResolvedValue([stageEntry]);
    deals.visibleIds.mockResolvedValue(new Set());
    const { data } = await service.list(actor, { kind: 'contact', id: 'contact' }, query);
    expect(data[0].metadata).toEqual({ kind: 'deal.stage_changed' });
    expect(JSON.stringify(data[0])).not.toMatch(/deal-1|"s1"|"s2"|OPEN/);
  });

  it('asks about all referenced deals in ONE call per page', async () => {
    repository.findPage.mockResolvedValue([
      stageEntry,
      { ...stageEntry, id: 'e2', metadata: { kind: 'x', deal: { dealId: 'deal-2' } } },
      { ...stageEntry, id: 'e3' },
    ]);
    await service.list(actor, { kind: 'contact', id: 'contact' }, query);
    expect(deals.visibleIds).toHaveBeenCalledTimes(1);
    expect(deals.visibleIds).toHaveBeenCalledWith(actor, ['deal-1', 'deal-2']);
  });

  it('a deal timeline shows everything and asks nothing: the parent check proved visibility', async () => {
    repository.findPage.mockResolvedValue([{ ...stageEntry, contactId: null, dealId: 'deal-1' }]);
    const { data } = await service.list(actor, { kind: 'deal', id: 'deal-1' }, query);
    expect(deals.visibleIds).not.toHaveBeenCalled();
    expect(data[0].metadata).toHaveProperty('deal.dealId', 'deal-1');
  });

  it('manual entries (no metadata) never trigger the lookup values', async () => {
    repository.findPage.mockResolvedValue([row()]);
    const { data } = await service.list(actor, { kind: 'lead', id: 'lead' }, query);
    expect(data[0]).toMatchObject({ metadata: null, isManual: true });
  });
});

describe('ActivitiesService.createManual', () => {
  it('checks the parent first and writes as the caller in the caller organization', async () => {
    repository.createManual.mockResolvedValue(row());
    await service.createManual(
      actor,
      { kind: 'lead', id: 'lead' },
      {
        type: 'NOTE',
        subject: 'Hi',
      },
    );
    expect(repository.createManual).toHaveBeenCalledWith({
      organizationId: ORG,
      actorId: 'me',
      parent: { kind: 'lead', id: 'lead' },
      type: 'NOTE',
      subject: 'Hi',
    });
  });

  it('writes nothing when the parent is hidden', async () => {
    contacts.get.mockRejectedValue(resourceNotFound('Contact'));
    expect(
      await statusOf(
        service.createManual(actor, { kind: 'contact', id: 'c' }, { type: 'CALL', subject: 'x' }),
      ),
    ).toBe(404);
    expect(repository.createManual).not.toHaveBeenCalled();
  });
});

describe('ActivitiesService.delete', () => {
  it('404 when the entry does not exist', async () => {
    repository.findOne.mockResolvedValue(null);
    expect(await statusOf(service.delete(actor, ID))).toBe(404);
  });

  it('the author deletes their note while they still see the parent', async () => {
    repository.findOne.mockResolvedValue(row());
    repository.deleteManual.mockResolvedValue(true);
    await service.delete(actor, ID);
    expect(leads.get).toHaveBeenCalledWith(actor, 'lead');
    expect(repository.deleteManual).toHaveBeenCalledWith(ID, 'me');
  });

  it('404 (not 403) for an author who lost sight of the parent; nothing is deleted', async () => {
    repository.findOne.mockResolvedValue(row());
    leads.get.mockRejectedValue(resourceNotFound('Lead'));
    const failed = service.delete(actor, ID);
    expect(await statusOf(failed)).toBe(404);
    expect(repository.deleteManual).not.toHaveBeenCalled();
  });

  it('the 404 for a hidden parent says "Activity", never the record kind', async () => {
    repository.findOne.mockResolvedValue(row());
    leads.get.mockRejectedValue(resourceNotFound('Lead'));
    const error = (await service.delete(actor, ID).catch((e: unknown) => e)) as HttpException;
    expect(JSON.stringify(error.getResponse())).toContain('Activity not found');
    expect(JSON.stringify(error.getResponse())).not.toContain('Lead');
  });

  it('a database error while checking the parent stays an error, not a 404', async () => {
    repository.findOne.mockResolvedValue(row());
    leads.get.mockRejectedValue(new Error('db down'));
    await expect(service.delete(actor, ID)).rejects.toThrow('db down');
  });

  it("403 ACTIVITY_DELETE_RESTRICTED for someone else's note when the caller can see it", async () => {
    repository.findOne.mockResolvedValue(row({ actorId: 'someone-else' }));
    const failed = service.delete(actor, ID);
    expect(await statusOf(failed)).toBe(403);
    expect((await codeOf(service.delete(actor, ID))).code).toBe('ACTIVITY_DELETE_RESTRICTED');
    expect(repository.deleteManual).not.toHaveBeenCalled();
  });

  it('409 ACTIVITY_IMMUTABLE for a system entry the caller can see, even for the same actor', async () => {
    repository.findOne.mockResolvedValue(row({ type: ActivityType.SYSTEM }));
    expect(await statusOf(service.delete(actor, ID))).toBe(409);
    expect((await codeOf(service.delete(actor, ID))).code).toBe('ACTIVITY_IMMUTABLE');
    expect(repository.deleteManual).not.toHaveBeenCalled();
  });

  it('a system entry on a hidden parent is the same 404, not a 409 that confirms it exists', async () => {
    repository.findOne.mockResolvedValue(row({ type: ActivityType.STAGE_CHANGE }));
    leads.get.mockRejectedValue(resourceNotFound('Lead'));
    expect(await statusOf(service.delete(actor, ID))).toBe(404);
  });

  describe('as an admin', () => {
    beforeEach(() => ownership.resolve.mockResolvedValue({ kind: 'all' }));

    it('deletes any manual entry without a parent check and without an author filter', async () => {
      repository.findOne.mockResolvedValue(row({ actorId: 'someone-else' }));
      repository.deleteManual.mockResolvedValue(true);
      await service.delete(actor, ID);
      expect(leads.get).not.toHaveBeenCalled();
      expect(repository.deleteManual).toHaveBeenCalledWith(ID, undefined);
    });

    it('still cannot delete a system entry', async () => {
      repository.findOne.mockResolvedValue(row({ type: ActivityType.SYSTEM }));
      expect(await statusOf(service.delete(actor, ID))).toBe(409);
    });
  });

  it('404 when the guarded delete matches nothing (it vanished since the read)', async () => {
    repository.findOne.mockResolvedValue(row());
    repository.deleteManual.mockResolvedValue(false);
    expect(await statusOf(service.delete(actor, ID))).toBe(404);
  });
});

describe('ActivitiesService.createFromJob', () => {
  it('hands the job to the idempotent insert', async () => {
    repository.createIfAbsent.mockResolvedValue('duplicate');
    const job = { dedupeKey: 'k' } as never;
    expect(await service.createFromJob(job)).toBe('duplicate');
    expect(repository.createIfAbsent).toHaveBeenCalledWith(job);
  });
});
