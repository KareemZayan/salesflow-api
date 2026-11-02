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
