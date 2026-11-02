import { HttpException } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { CompaniesRepository, CompanyRecord } from './companies.repository';
import { CompaniesService } from './companies.service';

const repository = {
  findPage: vi.fn(),
  findVisible: vi.fn(),
  create: vi.fn(),
  updateVisible: vi.fn(),
  softDeleteIfUnused: vi.fn(),
};
const ownership = { resolve: vi.fn(), resolveAssignableOwner: vi.fn() };
const service = new CompaniesService(
  repository as unknown as CompaniesRepository,
  ownership as unknown as OwnershipScopeService,
);

const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: 'org',
  role: 'SALES_REP',
  permissions: [],
  mustChangePassword: false,
};
const scope: VisibilityScope = { kind: 'owners', ownerIds: ['me'] };
const company = (overrides: Partial<CompanyRecord> = {}): CompanyRecord => ({
  id: 'c1',
  name: 'Acme',
  domain: null,
  industry: null,
  phone: null,
  address: null,
  ownerId: 'me',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});
const failure = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((e: unknown) => e)) as HttpException;
  return { status: error.getStatus(), body: JSON.stringify(error.getResponse()) };
};

beforeEach(() => {
  vi.resetAllMocks();
  ownership.resolve.mockResolvedValue(scope);
});

describe('CompaniesService.create', () => {
  it('defaults the owner to the caller, takes the organization from the caller', async () => {
    repository.create.mockResolvedValue(company());
    await service.create(actor, { name: 'Acme' });
    expect(repository.create).toHaveBeenCalledWith({
      name: 'Acme',
      organizationId: 'org',
      ownerId: 'me',
    });
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
  });

  it('naming yourself needs no extra check', async () => {
    repository.create.mockResolvedValue(company());
    await service.create(actor, { name: 'Acme', ownerId: 'me' });
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
  });

  it('another owner goes through resolveAssignableOwner with the caller scope', async () => {
    ownership.resolveAssignableOwner.mockResolvedValue('r1');
    repository.create.mockResolvedValue(company({ ownerId: 'r1' }));
    await service.create(actor, { name: 'Acme', ownerId: 'r1' });
    expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'r1');
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'r1' }));
  });

  it('an invalid owner stops the create', async () => {
    ownership.resolveAssignableOwner.mockRejectedValue(new HttpException('x', 400));
    await expect(service.create(actor, { name: 'A', ownerId: 'x' })).rejects.toThrow();
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('CompaniesService.get / list', () => {
  it('get answers 404 when the repository finds nothing visible', async () => {
    repository.findVisible.mockResolvedValue(null);
    const { status, body } = await failure(service.get(actor, 'c1'));
    expect(status).toBe(404);
    expect(body).toContain('RESOURCE_NOT_FOUND');
    expect(repository.findVisible).toHaveBeenCalledWith(scope, 'c1');
  });

  it('list hands the resolved scope to the repository', async () => {
    repository.findPage.mockResolvedValue({ data: [], meta: {} });
    const query = { page: 1, limit: 20, sortOrder: 'desc' as const };
    await service.list(actor, query);
    expect(repository.findPage).toHaveBeenCalledWith(scope, query);
  });
});

describe('CompaniesService.update', () => {
  it('rejects an empty body before touching anything', async () => {
    const { status, body } = await failure(service.update(actor, 'c1', {}));
    expect(status).toBe(400);
    expect(body).toContain('EMPTY_UPDATE');
    expect(ownership.resolve).not.toHaveBeenCalled();
    expect(repository.updateVisible).not.toHaveBeenCalled();
  });

  it('a plain edit is ONE guarded write, with no separate read', async () => {
    repository.updateVisible.mockResolvedValue(company({ name: 'New' }));
    await service.update(actor, 'c1', { name: 'New' });
    expect(repository.findVisible).not.toHaveBeenCalled();
    expect(repository.updateVisible).toHaveBeenCalledWith(scope, 'c1', { name: 'New' });
  });

  it('answers 404 when the guarded write matches nothing (not visible / reassigned meanwhile)', async () => {
    repository.updateVisible.mockResolvedValue(null);
    expect((await failure(service.update(actor, 'c1', { name: 'N' }))).status).toBe(404);
  });

  it('a real transfer is checked once and written', async () => {
    repository.findVisible.mockResolvedValue(company({ ownerId: 'me' }));
    ownership.resolveAssignableOwner.mockResolvedValue('r1');
    repository.updateVisible.mockResolvedValue(company({ ownerId: 'r1' }));
    await service.update(actor, 'c1', { ownerId: 'r1' });
    expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'r1');
    expect(repository.updateVisible).toHaveBeenCalledWith(scope, 'c1', { ownerId: 'r1' });
  });

  it('an unchanged ownerId is neither validated nor written', async () => {
    repository.findVisible.mockResolvedValue(company({ ownerId: 'inactive-report' }));
    repository.updateVisible.mockResolvedValue(company({ name: 'N', ownerId: 'inactive-report' }));
    await service.update(actor, 'c1', { ownerId: 'inactive-report', name: 'N' });
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
    expect(repository.updateVisible).toHaveBeenCalledWith(scope, 'c1', { name: 'N' });
  });

  it('a transfer of a company the caller cannot see is a 404, not an owner error', async () => {
    repository.findVisible.mockResolvedValue(null);
    expect((await failure(service.update(actor, 'c1', { ownerId: 'r1' }))).status).toBe(404);
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
  });

  it('a no-op edit that repeats stored values is still a normal update', async () => {
    repository.updateVisible.mockResolvedValue(company());
    await expect(service.update(actor, 'c1', { name: 'Acme' })).resolves.toEqual(company());
  });
});

describe('CompaniesService.delete', () => {
  it('resolves quietly when deleted', async () => {
    repository.softDeleteIfUnused.mockResolvedValue('deleted');
    await expect(service.delete(actor, 'c1')).resolves.toBeUndefined();
    expect(repository.softDeleteIfUnused).toHaveBeenCalledWith(scope, 'c1');
  });

  it('404 when missing, already deleted or invisible', async () => {
    repository.softDeleteIfUnused.mockResolvedValue('not-found');
    expect((await failure(service.delete(actor, 'c1'))).status).toBe(404);
  });

  it('409 COMPANY_HAS_CONTACTS without leaking a count or owners', async () => {
    repository.softDeleteIfUnused.mockResolvedValue('has-contacts');
    const { status, body } = await failure(service.delete(actor, 'c1'));
    expect(status).toBe(409);
    expect(body).toContain('COMPANY_HAS_CONTACTS');
    expect(body).toContain('Company has contacts and cannot be deleted');
  });

  it('409 COMPANY_HAS_DEALS without leaking a count or owners', async () => {
    repository.softDeleteIfUnused.mockResolvedValue('has-deals');
    const { status, body } = await failure(service.delete(actor, 'c1'));
    expect(status).toBe(409);
    expect(body).toContain('COMPANY_HAS_DEALS');
    expect(body).toContain('Company has open deals and cannot be deleted');
  });
});
