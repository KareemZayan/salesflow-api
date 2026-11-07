import { HttpException, Logger } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { Prisma } from '../../generated/prisma/client';
import { AuditService } from '../audit-logs/audit.service';
import { RoleRecord, RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

const TX = { tx: true };
const repository = {
  withOrgLock: vi.fn(),
  findPage: vi.fn(),
  findById: vi.fn(),
  findByNameIgnoringCase: vi.fn(),
  findPermissionsByKeys: vi.fn(),
  listPermissions: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  replacePermissions: vi.fn(),
  countUsers: vi.fn(),
  delete: vi.fn(),
};
const audit = { record: vi.fn() };
const service = new RolesService(
  repository as unknown as RolesRepository,
  audit as unknown as AuditService,
);

const actorOf = (role = 'ADMIN', permissions: string[] = []): AuthenticatedUser => ({
  userId: 'actor',
  organizationId: 'org',
  role,
  permissions,
  mustChangePassword: false,
});

const roleOf = (overrides: Partial<RoleRecord> & { keys?: string[] } = {}): RoleRecord => {
  const { keys = ['leads:read'], ...rest } = overrides;
  return {
    id: 'role-1',
    name: 'Support',
    description: '',
    isSystem: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    permissions: keys.map((key) => ({ permission: { key } })),
    _count: { users: 0 },
    ...rest,
  };
};

const failure = async (promise: Promise<unknown>): Promise<[number, string]> => {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return [http.getStatus(), (http.getResponse() as { code: string }).code];
  }
  throw new Error('expected a failure');
};

const catalogue = (...keys: string[]) =>
  repository.findPermissionsByKeys.mockResolvedValue(keys.map((key) => ({ id: `id-${key}`, key })));

beforeEach(() => {
  vi.resetAllMocks();
  repository.withOrgLock.mockImplementation((_org: string, work: (tx: unknown) => unknown) =>
    work(TX),
  );
  repository.findByNameIgnoringCase.mockResolvedValue(null);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('RolesService.create', () => {
  it.each(['admin', 'ADMIN', 'Sales_Rep', 'sales_manager'])(
    'rejects reserved name %s',
    async (name) => {
      expect(await failure(service.create(actorOf(), { name, permissionKeys: [] }))).toEqual([
        400,
        'ROLE_NAME_RESERVED',
      ]);
    },
  );

  it('rejects a name that differs only by case from an existing role', async () => {
    repository.findByNameIgnoringCase.mockResolvedValue({ id: 'other' });
    expect(
      await failure(service.create(actorOf(), { name: 'support', permissionKeys: [] })),
    ).toEqual([409, 'ROLE_NAME_ALREADY_EXISTS']);
  });

  it('maps the unique index (a race the lock missed) to the same error', async () => {
    catalogue();
    repository.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    expect(
      await failure(service.create(actorOf(), { name: 'Support', permissionKeys: [] })),
    ).toEqual([409, 'ROLE_NAME_ALREADY_EXISTS']);
  });

  it('rejects unknown permission keys', async () => {
    catalogue('leads:read');
    expect(
      await failure(
        service.create(actorOf(), { name: 'X', permissionKeys: ['leads:read', 'nope:nope'] }),
      ),
    ).toEqual([400, 'INVALID_PERMISSION']);
  });

  it('refuses to grant permissions the caller lacks, but ADMIN may', async () => {
    const helper = actorOf('SUPPORT', ['roles:manage', 'leads:read']);
    expect(
      await failure(service.create(helper, { name: 'X', permissionKeys: ['users:update'] })),
    ).toEqual([403, 'CANNOT_GRANT_PERMISSION']);

    catalogue('users:update');
    repository.create.mockResolvedValue(roleOf({ keys: ['users:update'] }));
    await service.create(actorOf(), { name: 'X', permissionKeys: ['users:update'] });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org', permissionIds: ['id-users:update'] }),
      TX,
    );
  });
});

describe('RolesService.update', () => {
  it('freezes the ADMIN role completely', async () => {
    repository.findById.mockResolvedValue(roleOf({ name: 'ADMIN', isSystem: true, keys: ['a:b'] }));
    catalogue();
    for (const dto of [{ permissionKeys: [] }, { description: 'x' }, { name: 'Boss' }]) {
      expect(await failure(service.update(actorOf(), 'role-1', dto))).toEqual([
        403,
        'SYSTEM_ROLE_IMMUTABLE',
      ]);
    }
  });

  it('identifies system roles by the flag, not by a name', async () => {
    repository.findById.mockResolvedValue(roleOf({ name: 'ADMIN', isSystem: false }));
    await service.update(actorOf(), 'role-1', { description: 'fine' });
    expect(repository.update).toHaveBeenCalled();
  });

  it('lets other system roles change permissions but not their name', async () => {
    repository.findById.mockResolvedValue(roleOf({ name: 'SALES_REP', isSystem: true }));
    catalogue('leads:read', 'deals:read');
    await service.update(actorOf(), 'role-1', { permissionKeys: ['leads:read', 'deals:read'] });
    expect(repository.replacePermissions).toHaveBeenCalledWith(
      'role-1',
      expect.arrayContaining(['id-leads:read', 'id-deals:read']),
      TX,
    );
    expect(await failure(service.update(actorOf(), 'role-1', { name: 'Reps' }))).toEqual([
      403,
      'SYSTEM_ROLE_IMMUTABLE',
    ]);
  });

  it('does not touch permissions when the set is unchanged', async () => {
    repository.findById.mockResolvedValue(roleOf({ keys: ['a:b', 'c:d'] }));
    await service.update(actorOf(), 'role-1', { permissionKeys: ['c:d', 'a:b'] });
    expect(repository.replacePermissions).not.toHaveBeenCalled();
  });

  it('refuses to edit a role holding permissions the caller lacks', async () => {
    repository.findById.mockResolvedValue(roleOf({ keys: ['roles:manage'] }));
    const helper = actorOf('SUPPORT', ['leads:read']);
    expect(await failure(service.update(helper, 'role-1', { description: 'x' }))).toEqual([
      403,
      'CANNOT_GRANT_PERMISSION',
    ]);
  });

  it('rejects renaming to a reserved or taken name', async () => {
    repository.findById.mockResolvedValue(roleOf());
    expect(await failure(service.update(actorOf(), 'role-1', { name: 'admin' }))).toEqual([
      400,
      'ROLE_NAME_RESERVED',
    ]);
    repository.findByNameIgnoringCase.mockResolvedValue({ id: 'other' });
    expect(await failure(service.update(actorOf(), 'role-1', { name: 'Taken' }))).toEqual([
      409,
      'ROLE_NAME_ALREADY_EXISTS',
    ]);
  });
});

describe('RolesService.delete', () => {
  it('refuses system roles', async () => {
    repository.findById.mockResolvedValue(roleOf({ isSystem: true, name: 'SALES_REP' }));
    expect(await failure(service.delete(actorOf(), 'role-1'))).toEqual([
      403,
      'SYSTEM_ROLE_IMMUTABLE',
    ]);
  });

  it('refuses a role that users hold (the count includes inactive users)', async () => {
    repository.findById.mockResolvedValue(roleOf());
    repository.countUsers.mockResolvedValue(1);
    expect(await failure(service.delete(actorOf(), 'role-1'))).toEqual([409, 'ROLE_IN_USE']);
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('deletes an unused custom role and answers 404 for an unknown one', async () => {
    repository.findById.mockResolvedValue(roleOf());
    repository.countUsers.mockResolvedValue(0);
    await service.delete(actorOf(), 'role-1');
    expect(repository.delete).toHaveBeenCalledWith('role-1', TX);

    repository.findById.mockResolvedValue(null);
    expect(await failure(service.delete(actorOf(), 'ghost'))).toEqual([404, 'RESOURCE_NOT_FOUND']);
  });
});

describe('RolesService.list', () => {
  it('maps records with sorted keys and the user count from _count', async () => {
    repository.findPage.mockResolvedValue({
      data: [roleOf({ keys: ['z:z', 'a:a'], _count: { users: 3 } })],
      meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    const page = await service.list({ page: 1, limit: 20, sortOrder: 'asc' });
    expect(page.data[0]).toMatchObject({ permissionKeys: ['a:a', 'z:z'], userCount: 3 });
  });
});

describe('RolesService audit', () => {
  it('records role.created with the name and sorted permission keys, in the same transaction', async () => {
    catalogue('users:update', 'leads:read');
    repository.create.mockResolvedValue(roleOf({ keys: ['users:update', 'leads:read'] }));
    await service.create(actorOf(), {
      name: 'Support',
      permissionKeys: ['users:update', 'leads:read'],
    });
    expect(audit.record).toHaveBeenCalledWith(TX, {
      event: 'role.created',
      entityId: 'role-1',
      after: { name: 'Support', permissionKeys: ['leads:read', 'users:update'] },
    });
  });

  it('records a rename and a permission change as two events, each with its own field', async () => {
    repository.findById
      .mockResolvedValueOnce(roleOf({ keys: ['leads:read'] }))
      .mockResolvedValueOnce(roleOf({ name: 'Helpdesk', keys: ['leads:read', 'deals:read'] }));
    catalogue('leads:read', 'deals:read');
    await service.update(actorOf(), 'role-1', {
      name: 'Helpdesk',
      permissionKeys: ['leads:read', 'deals:read'],
    });
    expect(audit.record).toHaveBeenCalledWith(TX, {
      event: 'role.updated',
      entityId: 'role-1',
      before: { name: 'Support' },
      after: { name: 'Helpdesk' },
    });
    expect(audit.record).toHaveBeenCalledWith(TX, {
      event: 'role.permissions_changed',
      entityId: 'role-1',
      before: { permissionKeys: ['leads:read'] },
      after: { permissionKeys: ['deals:read', 'leads:read'] },
    });
  });

  it('records role.deleted with what the role was', async () => {
    repository.findById.mockResolvedValue(roleOf());
    repository.countUsers.mockResolvedValue(0);
    await service.delete(actorOf(), 'role-1');
    expect(audit.record).toHaveBeenCalledWith(TX, {
      event: 'role.deleted',
      entityId: 'role-1',
      before: { name: 'Support', permissionKeys: ['leads:read'] },
    });
  });

  it('fails the delete when the audit insert fails (the error reaches the transaction)', async () => {
    repository.findById.mockResolvedValue(roleOf());
    repository.countUsers.mockResolvedValue(0);
    audit.record.mockRejectedValue(new Error('audit down'));
    await expect(service.delete(actorOf(), 'role-1')).rejects.toThrow('audit down');
  });
});
