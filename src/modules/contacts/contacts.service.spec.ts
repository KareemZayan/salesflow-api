import { HttpException } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { CompaniesService } from '../companies/companies.service';
import { ContactRecord, ContactsRepository } from './contacts.repository';
import { ContactsService } from './contacts.service';

const repository = {
  findPage: vi.fn(),
  findVisible: vi.fn(),
  create: vi.fn(),
  updateVisible: vi.fn(),
  deleteVisible: vi.fn(),
};
const ownership = { resolve: vi.fn(), resolveAssignableOwner: vi.fn() };
const companies = { assertLinkable: vi.fn() };
const service = new ContactsService(
  repository as unknown as ContactsRepository,
  ownership as unknown as OwnershipScopeService,
  companies as unknown as CompaniesService,
);

const actor: AuthenticatedUser = {
  userId: 'me',
  organizationId: 'org',
  role: 'SALES_REP',
  permissions: [],
  mustChangePassword: false,
};
const scope: VisibilityScope = { kind: 'owners', ownerIds: ['me'] };
const contact = (overrides: Partial<ContactRecord> = {}): ContactRecord => ({
  id: 'k1',
  firstName: 'Sara',
  lastName: 'Hassan',
  email: null,
  phone: null,
  jobTitle: null,
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
// The `link` handed to the repository: running `verify` is what the repository does under the lock.
const linkOf = (call: unknown[] | undefined, index: number) =>
  call?.[index] as { companyId: string; verify: (db: never) => Promise<void> } | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  ownership.resolve.mockResolvedValue(scope);
});

describe('ContactsService.create', () => {
  it('defaults the owner to the caller, takes the organization from the caller, no company check', async () => {
    repository.create.mockResolvedValue(contact());
    await service.create(actor, { firstName: 'Sara', lastName: 'Hassan' });
    expect(repository.create).toHaveBeenCalledWith(
      { firstName: 'Sara', lastName: 'Hassan', organizationId: 'org', ownerId: 'me' },
      undefined,
    );
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
  });

  it('another owner goes through resolveAssignableOwner with the caller scope', async () => {
    ownership.resolveAssignableOwner.mockResolvedValue('r1');
    repository.create.mockResolvedValue(contact({ ownerId: 'r1' }));
    await service.create(actor, { firstName: 'S', lastName: 'H', ownerId: 'r1' });
    expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'r1');
  });

  it('an invalid owner stops the create', async () => {
    ownership.resolveAssignableOwner.mockRejectedValue(new HttpException('x', 400));
    await expect(
      service.create(actor, { firstName: 'S', lastName: 'H', ownerId: 'x' }),
    ).rejects.toThrow();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('a company is verified by CompaniesService through the link, with the caller scope', async () => {
    repository.create.mockResolvedValue(contact({ companyId: 'c1' }));
    await service.create(actor, { firstName: 'S', lastName: 'H', companyId: 'c1' });
    const link = linkOf(repository.create.mock.calls[0], 1);
    expect(link?.companyId).toBe('c1');
    // Nothing is checked until the repository runs `verify` (inside its transaction and lock).
    expect(companies.assertLinkable).not.toHaveBeenCalled();
    const tx = {} as never;
    await link?.verify(tx);
    expect(companies.assertLinkable).toHaveBeenCalledWith(tx, scope, 'c1');
  });
});

describe('ContactsService.get / list / delete', () => {
  it('get answers 404 when the repository finds nothing visible', async () => {
    repository.findVisible.mockResolvedValue(null);
    const { status, body } = await failure(service.get(actor, 'k1'));
    expect(status).toBe(404);
    expect(body).toContain('RESOURCE_NOT_FOUND');
    expect(repository.findVisible).toHaveBeenCalledWith(scope, 'k1');
  });

  it('list hands the resolved scope to the repository', async () => {
    repository.findPage.mockResolvedValue({ data: [], meta: {} });
    const query = { page: 1, limit: 20, sortOrder: 'desc' as const };
    await service.list(actor, query);
    expect(repository.findPage).toHaveBeenCalledWith(scope, query);
  });

  it('delete answers 404 when nothing visible was deleted', async () => {
    repository.deleteVisible.mockResolvedValue(false);
    expect((await failure(service.delete(actor, 'k1'))).status).toBe(404);
    expect(repository.deleteVisible).toHaveBeenCalledWith(scope, 'k1');
  });

  it('delete resolves when a visible contact was deleted', async () => {
    repository.deleteVisible.mockResolvedValue(true);
    await expect(service.delete(actor, 'k1')).resolves.toBeUndefined();
  });
});

describe('ContactsService.update', () => {
  it('rejects an empty body before touching anything', async () => {
    const { status, body } = await failure(service.update(actor, 'k1', {}));
    expect(status).toBe(400);
    expect(body).toContain('EMPTY_UPDATE');
    expect(ownership.resolve).not.toHaveBeenCalled();
    expect(repository.updateVisible).not.toHaveBeenCalled();
  });

  it('a plain edit is ONE guarded write, with no read and no link', async () => {
    repository.updateVisible.mockResolvedValue(contact({ firstName: 'New' }));
    await service.update(actor, 'k1', { firstName: 'New' });
    expect(repository.findVisible).not.toHaveBeenCalled();
    expect(repository.updateVisible).toHaveBeenCalledWith(
      scope,
      'k1',
      { firstName: 'New' },
      undefined,
    );
  });

  it('answers 404 when the guarded write matches nothing (not visible / reassigned meanwhile)', async () => {
    repository.updateVisible.mockResolvedValue(null);
    expect((await failure(service.update(actor, 'k1', { firstName: 'N' }))).status).toBe(404);
  });

  it('a real transfer is checked once and written', async () => {
    repository.findVisible.mockResolvedValue(contact({ ownerId: 'me' }));
    ownership.resolveAssignableOwner.mockResolvedValue('r1');
    repository.updateVisible.mockResolvedValue(contact({ ownerId: 'r1' }));
    await service.update(actor, 'k1', { ownerId: 'r1' });
    expect(ownership.resolveAssignableOwner).toHaveBeenCalledWith(scope, 'r1');
    expect(repository.updateVisible).toHaveBeenCalledWith(
      scope,
      'k1',
      { ownerId: 'r1' },
      undefined,
    );
  });

  it('an unchanged ownerId is neither validated nor written', async () => {
    repository.findVisible.mockResolvedValue(contact({ ownerId: 'inactive-report' }));
    repository.updateVisible.mockResolvedValue(contact());
    await service.update(actor, 'k1', { ownerId: 'inactive-report', firstName: 'N' });
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
    expect(repository.updateVisible).toHaveBeenCalledWith(
      scope,
      'k1',
      { firstName: 'N' },
      undefined,
    );
  });

  it('changing the company links to the NEW company only', async () => {
    repository.findVisible.mockResolvedValue(contact({ companyId: 'old' }));
    repository.updateVisible.mockResolvedValue(contact({ companyId: 'new' }));
    await service.update(actor, 'k1', { companyId: 'new' });
    const [, , changes, link] = repository.updateVisible.mock.calls[0];
    expect(changes).toEqual({ companyId: 'new' });
    expect(linkOf([link], 0)?.companyId).toBe('new');
  });

  it('an unchanged companyId is neither verified nor written (the company may have moved)', async () => {
    repository.findVisible.mockResolvedValue(contact({ companyId: 'c1' }));
    repository.updateVisible.mockResolvedValue(contact({ companyId: 'c1', firstName: 'N' }));
    await service.update(actor, 'k1', { companyId: 'c1', firstName: 'N' });
    expect(repository.updateVisible).toHaveBeenCalledWith(
      scope,
      'k1',
      { firstName: 'N' },
      undefined,
    );
  });

  it('unlinking needs no read, no check and no lock', async () => {
    repository.updateVisible.mockResolvedValue(contact());
    await service.update(actor, 'k1', { companyId: null });
    expect(repository.findVisible).not.toHaveBeenCalled();
    expect(repository.updateVisible).toHaveBeenCalledWith(
      scope,
      'k1',
      { companyId: null },
      undefined,
    );
  });

  it('a link or transfer on a contact the caller cannot see is a 404, not an owner/company error', async () => {
    repository.findVisible.mockResolvedValue(null);
    expect((await failure(service.update(actor, 'k1', { ownerId: 'r1' }))).status).toBe(404);
    expect((await failure(service.update(actor, 'k1', { companyId: 'c1' }))).status).toBe(404);
    expect(ownership.resolveAssignableOwner).not.toHaveBeenCalled();
    expect(repository.updateVisible).not.toHaveBeenCalled();
  });
});
