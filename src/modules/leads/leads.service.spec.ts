import { HttpException } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { LeadSource, LeadStatus } from '../../generated/prisma/client';
import { LeadRecord, LeadsRepository } from './leads.repository';
import { LeadsService } from './leads.service';
import { LeadScoringStrategy } from './scoring/lead-scoring.strategy';

const repository = {
  findPage: vi.fn(),
  findVisible: vi.fn(),
  create: vi.fn(),
  updateVisible: vi.fn(),
  deleteVisible: vi.fn(),
  transitionStatus: vi.fn(),
};
const ownership = { resolve: vi.fn(), resolveAssignableOwner: vi.fn() };
const scoring = { score: vi.fn() };
const service = new LeadsService(
  repository as unknown as LeadsRepository,
  ownership as unknown as OwnershipScopeService,
  scoring as LeadScoringStrategy,
);

const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: 'org',
  role: 'SALES_REP',
  permissions: [],
  mustChangePassword: false,
};
const scope: VisibilityScope = { kind: 'owners', ownerIds: ['me'] };
const lead = (overrides: Partial<LeadRecord> = {}): LeadRecord => ({
  id: 'l1',
  firstName: 'Omar',
  lastName: 'Khaled',
  email: null,
  phone: null,
  companyName: null,
  source: LeadSource.WEBSITE,
  status: LeadStatus.NEW,
  score: 30,
  notes: null,
  ownerId: 'me',
  convertedAt: null,
  convertedContactId: null,
  convertedDealId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});
const failure = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as HttpException;
  return { status: error.getStatus(), body: JSON.stringify(error.getResponse()) };
};
// The `rescore` handed to the repository (4th argument of updateVisible), or undefined.
const rescoreOf = () =>
  repository.updateVisible.mock.calls[0]?.[3] as
    | ((current: {
        source: LeadSource;
        email: string | null;
        phone: string | null;
        companyName: string | null;
      }) => number)
    | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  ownership.resolve.mockResolvedValue(scope);
  scoring.score.mockReturnValue(42);
});

describe('LeadsService.create', () => {
  it('owner defaults to the caller, organization comes from the caller, score from the strategy', async () => {
    repository.create.mockResolvedValue(lead());
    await service.create(actor, {
      firstName: 'Omar',
      lastName: 'Khaled',
      source: LeadSource.REFERRAL,
      email: 'o@g.com',
    });
    expect(scoring.score).toHaveBeenCalledWith({
      source: LeadSource.REFERRAL,
      email: 'o@g.com',
      phone: null,
      companyName: null,
    });
    expect(repository.create).toHaveBeenCalledWith({
      firstName: 'Omar',
      lastName: 'Khaled',
      source: LeadSource.REFERRAL,
      email: 'o@g.com',
      organizationId: 'org',
      ownerId: 'me',
      score: 42,
    });
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
  });

  it('another owner goes through resolveAssignableOwner with the caller scope', async () => {
    ownership.resolveAssignableOwner.mockResolvedValue('r1');
    repository.create.mockResolvedValue(lead({ ownerId: 'r1' }));
    await service.create(actor, {
      firstName: 'O',
      lastName: 'K',
      source: LeadSource.OTHER,
      ownerId: 'r1',
    });
    expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'r1');
    expect(repository.create.mock.calls[0]?.[0]).toMatchObject({ ownerId: 'r1' });
  });

  it('an invalid owner stops the create', async () => {
    ownership.resolveAssignableOwner.mockRejectedValue(new HttpException('x', 400));
    await expect(
      service.create(actor, {
        firstName: 'O',
        lastName: 'K',
        source: LeadSource.OTHER,
        ownerId: 'x',
      }),
    ).rejects.toThrow();
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('LeadsService.get / list / delete', () => {
  it('get answers 404 when the repository finds nothing visible', async () => {
    repository.findVisible.mockResolvedValue(null);
    expect(await failure(service.get(actor, 'l1'))).toMatchObject({ status: 404 });
    expect(repository.findVisible).toHaveBeenCalledWith(scope, 'l1');
  });

  it('list passes the resolved scope to the repository', async () => {
    repository.findPage.mockResolvedValue({ data: [], meta: {} });
    await service.list(actor, {} as never);
    expect(repository.findPage).toHaveBeenCalledWith(scope, {});
  });

  it('delete answers 404 when nothing was deleted', async () => {
    repository.deleteVisible.mockResolvedValue(false);
    expect(await failure(service.delete(actor, 'l1'))).toMatchObject({ status: 404 });
  });

  it('delete succeeds silently when a visible lead was deleted', async () => {
    repository.deleteVisible.mockResolvedValue(true);
    await expect(service.delete(actor, 'l1')).resolves.toBeUndefined();
  });
});

describe('LeadsService.update', () => {
  it('rejects an empty body with EMPTY_UPDATE before touching anything', async () => {
    const res = await failure(service.update(actor, 'l1', {}));
    expect(res.status).toBe(400);
    expect(res.body).toContain('EMPTY_UPDATE');
    expect(repository.updateVisible).not.toHaveBeenCalled();
  });

  it.each([
    ['notes', { notes: 'call back' }],
    ['firstName', { firstName: 'Nora' }],
    ['lastName', { lastName: 'Ali' }],
  ])('a non-scoring change (%s) passes no rescore, so no lock is taken', async (_name, dto) => {
    repository.updateVisible.mockResolvedValue(lead());
    await service.update(actor, 'l1', dto);
    expect(rescoreOf()).toBeUndefined();
    expect(scoring.score).not.toHaveBeenCalled();
  });

  it('an owner-only change needs no rescore and no lock', async () => {
    repository.findVisible.mockResolvedValue(lead());
    ownership.resolveAssignableOwner.mockResolvedValue('r1');
    repository.updateVisible.mockResolvedValue(lead({ ownerId: 'r1' }));
    await service.update(actor, 'l1', { ownerId: 'r1' });
    expect(repository.updateVisible).toHaveBeenCalledWith(
      scope,
      'l1',
      { ownerId: 'r1' },
      undefined,
    );
  });

  it.each([
    ['source', { source: LeadSource.PARTNER }],
    ['email', { email: 'a@b.co' }],
    ['phone', { phone: '12345' }],
    ['companyName', { companyName: 'Acme' }],
    ['a cleared email (null)', { email: null }],
  ])('a scoring change (%s) passes a rescore', async (_name, dto) => {
    repository.updateVisible.mockResolvedValue(lead());
    await service.update(actor, 'l1', dto);
    expect(rescoreOf()).toBeTypeOf('function');
  });

  it('rescore merges the stored row with ONLY the fields that were sent', async () => {
    repository.updateVisible.mockResolvedValue(lead());
    await service.update(actor, 'l1', { phone: '12345', notes: 'x' });
    const stored = {
      source: LeadSource.EVENT,
      email: 'old@b.co',
      phone: null,
      companyName: 'Acme',
    };
    expect(rescoreOf()?.(stored)).toBe(42);
    expect(scoring.score).toHaveBeenCalledWith({ ...stored, phone: '12345' });
  });

  it('a cleared field overrides the stored value in the merged input', async () => {
    repository.updateVisible.mockResolvedValue(lead());
    await service.update(actor, 'l1', { email: null });
    const stored = { source: LeadSource.EVENT, email: 'old@b.co', phone: null, companyName: null };
    rescoreOf()?.(stored);
    expect(scoring.score).toHaveBeenCalledWith({ ...stored, email: null });
  });

  it('only the plain fields reach the repository as changes (ownerId handled separately)', async () => {
    repository.updateVisible.mockResolvedValue(lead());
    await service.update(actor, 'l1', { notes: 'n', email: 'a@b.co' });
    expect(repository.updateVisible.mock.calls[0]?.slice(0, 3)).toEqual([
      scope,
      'l1',
      { notes: 'n', email: 'a@b.co' },
    ]);
  });

  it('404 when the repository finds nothing visible to write', async () => {
    repository.updateVisible.mockResolvedValue(null);
    expect(await failure(service.update(actor, 'l1', { notes: 'x' }))).toMatchObject({
      status: 404,
    });
  });

  describe('ownership transfer', () => {
    it('404 when the lead is not visible, without validating the new owner', async () => {
      repository.findVisible.mockResolvedValue(null);
      expect(await failure(service.update(actor, 'l1', { ownerId: 'r1' }))).toMatchObject({
        status: 404,
      });
      expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
    });

    it('an unchanged ownerId is not re-validated and not written', async () => {
      repository.findVisible.mockResolvedValue(lead({ ownerId: 'me' }));
      repository.updateVisible.mockResolvedValue(lead());
      await service.update(actor, 'l1', { ownerId: 'me', notes: 'x' });
      expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
      expect(repository.updateVisible.mock.calls[0]?.[2]).toEqual({
        ownerId: undefined,
        notes: 'x',
      });
    });

    it('a real transfer goes through resolveAssignableOwner; a rejection stops the write', async () => {
      repository.findVisible.mockResolvedValue(lead());
      ownership.resolveAssignableOwner.mockRejectedValue(new HttpException('x', 400));
      await expect(service.update(actor, 'l1', { ownerId: 'other' })).rejects.toThrow();
      expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'other');
      expect(repository.updateVisible).not.toHaveBeenCalled();
    });
  });
});

const converted = () => lead({ status: LeadStatus.CONVERTED });
const code = (res: { body: string }) => (JSON.parse(res.body) as { code: string }).code;

describe('LeadsService.changeStatus', () => {
  it('writes with the status it just READ as `from`, and returns the written lead', async () => {
    repository.findVisible.mockResolvedValue(lead({ status: LeadStatus.NEW }));
    repository.transitionStatus.mockResolvedValue(lead({ status: LeadStatus.CONTACTED }));
    const result = await service.changeStatus(actor, 'l1', { status: LeadStatus.CONTACTED });
    expect(result.status).toBe(LeadStatus.CONTACTED);
    expect(repository.transitionStatus).toHaveBeenCalledWith(
      scope,
      'l1',
      LeadStatus.NEW,
      LeadStatus.CONTACTED,
    );
    expect(scoring.score).not.toHaveBeenCalled();
  });

  it('404 when the lead is not visible; nothing is written', async () => {
    repository.findVisible.mockResolvedValue(null);
    const res = await failure(service.changeStatus(actor, 'l1', { status: LeadStatus.CONTACTED }));
    expect(res.status).toBe(404);
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('409 INVALID_STATUS_TRANSITION for a move the map forbids, including the same status', async () => {
    repository.findVisible.mockResolvedValue(lead({ status: LeadStatus.NEW }));
    for (const status of [LeadStatus.QUALIFIED, LeadStatus.NEW]) {
      const res = await failure(service.changeStatus(actor, 'l1', { status }));
      expect(res.status).toBe(409);
      expect(code(res)).toBe('INVALID_STATUS_TRANSITION');
    }
    expect(repository.transitionStatus).not.toHaveBeenCalled();
  });

  it('409 LEAD_ALREADY_CONVERTED from a converted lead', async () => {
    repository.findVisible.mockResolvedValue(converted());
    const res = await failure(service.changeStatus(actor, 'l1', { status: LeadStatus.CONTACTED }));
    expect(res.status).toBe(409);
    expect(code(res)).toBe('LEAD_ALREADY_CONVERTED');
  });

  describe('when the compare-and-set loses a race', () => {
    beforeEach(() => {
      repository.transitionStatus.mockResolvedValue(null);
    });

    it('409 INVALID_STATUS_TRANSITION when the status moved on', async () => {
      repository.findVisible
        .mockResolvedValueOnce(lead({ status: LeadStatus.NEW }))
        .mockResolvedValueOnce(lead({ status: LeadStatus.UNQUALIFIED }));
      const res = await failure(
        service.changeStatus(actor, 'l1', { status: LeadStatus.CONTACTED }),
      );
      expect(res.status).toBe(409);
      expect(code(res)).toBe('INVALID_STATUS_TRANSITION');
    });

    it('409 LEAD_ALREADY_CONVERTED when it was converted meanwhile', async () => {
      repository.findVisible
        .mockResolvedValueOnce(lead({ status: LeadStatus.QUALIFIED }))
        .mockResolvedValueOnce(converted());
      const res = await failure(
        service.changeStatus(actor, 'l1', { status: LeadStatus.UNQUALIFIED }),
      );
      expect(code(res)).toBe('LEAD_ALREADY_CONVERTED');
    });

    it('404 when it became invisible meanwhile (reassigned away or deleted)', async () => {
      repository.findVisible
        .mockResolvedValueOnce(lead({ status: LeadStatus.NEW }))
        .mockResolvedValueOnce(null);
      const res = await failure(
        service.changeStatus(actor, 'l1', { status: LeadStatus.CONTACTED }),
      );
      expect(res.status).toBe(404);
    });
  });
});

describe('converted leads are final', () => {
  it('update: a write that matched nothing on a visible converted lead is 409, not 404', async () => {
    repository.updateVisible.mockResolvedValue(null);
    repository.findVisible.mockResolvedValue(converted());
    const res = await failure(service.update(actor, 'l1', { notes: 'x' }));
    expect(res.status).toBe(409);
    expect(code(res)).toBe('LEAD_ALREADY_CONVERTED');
  });

  it('update: a write that matched nothing on an invisible lead is 404 (never reveals it)', async () => {
    repository.updateVisible.mockResolvedValue(null);
    repository.findVisible.mockResolvedValue(null);
    expect(await failure(service.update(actor, 'l1', { notes: 'x' }))).toMatchObject({
      status: 404,
    });
  });

  it('update: an empty body is 400 before the converted 409 is even considered', async () => {
    const res = await failure(service.update(actor, 'l1', {}));
    expect(res.status).toBe(400);
    expect(code(res)).toBe('EMPTY_UPDATE');
    expect(repository.findVisible).not.toHaveBeenCalled();
    expect(repository.updateVisible).not.toHaveBeenCalled();
  });

  it('update: an owner transfer of a converted lead is 409 before the new owner is judged', async () => {
    repository.findVisible.mockResolvedValue(converted());
    const res = await failure(service.update(actor, 'l1', { ownerId: 'r1' }));
    expect(code(res)).toBe('LEAD_ALREADY_CONVERTED');
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
    expect(repository.updateVisible).not.toHaveBeenCalled();
  });

  it('delete: 409 for a visible converted lead, 404 otherwise', async () => {
    repository.deleteVisible.mockResolvedValue(false);
    repository.findVisible.mockResolvedValueOnce(converted());
    expect(code(await failure(service.delete(actor, 'l1')))).toBe('LEAD_ALREADY_CONVERTED');
    repository.findVisible.mockResolvedValueOnce(null);
    expect(await failure(service.delete(actor, 'l1'))).toMatchObject({ status: 404 });
  });
});
