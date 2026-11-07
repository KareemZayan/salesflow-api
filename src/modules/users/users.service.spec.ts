import { HttpException, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { AuditService } from '../audit-logs/audit.service';
import { PasswordService } from '../auth/password.service';
import { SessionRevoker } from '../auth/session-revoker.service';
import { UserRecord, UsersRepository } from './users.repository';
import { UsersService } from './users.service';

const ORG = 'org-1';
const TX = { tx: true };

const repository = {
  withOrgLock: vi.fn(),
  findById: vi.fn(),
  findPage: vi.fn(),
  findRole: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  countOtherActiveAdmins: vi.fn(),
  countActiveReports: vi.fn(),
};
const passwords = {
  assertAcceptable: vi.fn(),
  hash: vi.fn().mockResolvedValue('hashed'),
} as unknown as PasswordService;
const sessions = { revokeAllForUser: vi.fn() };
const audit = { record: vi.fn() };
const service = new UsersService(
  repository as unknown as UsersRepository,
  passwords,
  sessions as unknown as SessionRevoker,
  audit as unknown as AuditService,
);

const actorOf = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  userId: 'actor',
  organizationId: ORG,
  role: 'ADMIN',
  permissions: ['users:update'],
  mustChangePassword: false,
  ...overrides,
});

const userOf = (overrides: Partial<UserRecord> = {}): UserRecord => ({
  id: 'target',
  email: 't@x.test',
  firstName: 'T',
  lastName: 'U',
  isActive: true,
  mustChangePassword: false,
  managerId: null,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  role: { id: 'role-rep', name: 'SALES_REP' },
  ...overrides,
});

const adminOf = (overrides: Partial<UserRecord> = {}) =>
  userOf({ role: { id: 'role-admin', name: 'ADMIN' }, ...overrides });

const failure = async (promise: Promise<unknown>): Promise<[number, string]> => {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return [http.getStatus(), (http.getResponse() as { code: string }).code];
  }
  throw new Error('expected a failure');
};

// Looks users up by id from a fixture map, like the repository would.
const usersById = (...users: UserRecord[]) =>
  repository.findById.mockImplementation((id: string) =>
    Promise.resolve(users.find((u) => u.id === id) ?? null),
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(passwords.hash).mockResolvedValue('hashed');
  repository.withOrgLock.mockImplementation((_org: string, work: (tx: unknown) => unknown) =>
    work(TX),
  );
  repository.update.mockImplementation((_id: string, data: object) =>
    Promise.resolve(userOf(data)),
  );
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('UsersService.deactivate', () => {
  it('refuses to deactivate yourself', async () => {
    expect(await failure(service.deactivate(actorOf({ userId: 'target' }), 'target'))).toEqual([
      403,
      'CANNOT_DEACTIVATE_SELF',
    ]);
  });

  it('refuses to remove the last active admin', async () => {
    usersById(adminOf());
    repository.countOtherActiveAdmins.mockResolvedValue(0);
    expect(await failure(service.deactivate(actorOf(), 'target'))).toEqual([
      409,
      'LAST_ADMIN_REQUIRED',
    ]);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('allows removing an admin when another active admin remains', async () => {
    usersById(adminOf());
    repository.countOtherActiveAdmins.mockResolvedValue(1);
    repository.countActiveReports.mockResolvedValue(0);
    await service.deactivate(actorOf(), 'target');
    expect(repository.update).toHaveBeenCalledWith('target', { isActive: false }, TX);
  });

  it('refuses while the user still has active direct reports', async () => {
    usersById(userOf());
    repository.countActiveReports.mockResolvedValue(2);
    expect(await failure(service.deactivate(actorOf(), 'target'))).toEqual([
      409,
      'USER_HAS_ACTIVE_REPORTS',
    ]);
  });

  it('revokes every session in the same transaction', async () => {
    usersById(userOf());
    repository.countActiveReports.mockResolvedValue(0);
    await service.deactivate(actorOf(), 'target');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(TX, 'target', expect.any(Date));
  });

  it('is idempotent for an already inactive user', async () => {
    usersById(userOf({ isActive: false }));
    await service.deactivate(actorOf(), 'target');
    expect(repository.update).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown (or other-organization) user', async () => {
    usersById();
    expect(await failure(service.deactivate(actorOf(), 'ghost'))).toEqual([
      404,
      'RESOURCE_NOT_FOUND',
    ]);
  });
});

describe('privilege escalation guard', () => {
  const support = actorOf({ role: 'SUPPORT' });

  it.each([
    ['update', () => service.update(support, 'target', { firstName: 'X' })],
    ['deactivate', () => service.deactivate(support, 'target')],
    ['reactivate', () => service.reactivate(support, 'target')],
    ['reset-password', () => service.resetPassword(support, 'target', { temporaryPassword: 'x' })],
  ])('a non-admin cannot %s an ADMIN account', async (_name, act) => {
    usersById(adminOf());
    expect(await failure(act())).toEqual([403, 'ADMIN_REQUIRED']);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('a non-admin cannot assign the ADMIN role (update)', async () => {
    usersById(userOf());
    repository.findRole.mockResolvedValue({ id: 'role-admin', name: 'ADMIN' });
    expect(await failure(service.update(support, 'target', { roleId: 'role-admin' }))).toEqual([
      403,
      'ADMIN_REQUIRED',
    ]);
  });

  it('a non-admin cannot create an ADMIN', async () => {
    repository.findRole.mockResolvedValue({ id: 'role-admin', name: 'ADMIN' });
    expect(
      await failure(
        service.create(support, {
          email: 'a@x.test',
          firstName: 'A',
          lastName: 'B',
          roleId: 'role-admin',
          temporaryPassword: 'whatever-long-enough',
        }),
      ),
    ).toEqual([403, 'ADMIN_REQUIRED']);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('a non-admin can still manage non-admin accounts', async () => {
    usersById(userOf());
    repository.countActiveReports.mockResolvedValue(0);
    await service.deactivate(support, 'target');
    expect(repository.update).toHaveBeenCalled();
  });
});

describe('UsersService.update', () => {
  it('refuses to change your own role', async () => {
    usersById(adminOf({ id: 'actor' }));
    repository.findRole.mockResolvedValue({ id: 'role-rep', name: 'SALES_REP' });
    expect(await failure(service.update(actorOf(), 'actor', { roleId: 'role-rep' }))).toEqual([
      403,
      'CANNOT_CHANGE_OWN_ROLE',
    ]);
  });

  it('ignores a roleId equal to the current one on yourself', async () => {
    usersById(adminOf({ id: 'actor' }));
    await service.update(actorOf(), 'actor', { roleId: 'role-admin', firstName: 'New' });
    expect(repository.update).toHaveBeenCalledWith(
      'actor',
      expect.objectContaining({ firstName: 'New' }),
      TX,
    );
  });

  it('refuses to demote the last active admin', async () => {
    usersById(adminOf());
    repository.findRole.mockResolvedValue({ id: 'role-rep', name: 'SALES_REP' });
    repository.countOtherActiveAdmins.mockResolvedValue(0);
    expect(await failure(service.update(actorOf(), 'target', { roleId: 'role-rep' }))).toEqual([
      409,
      'LAST_ADMIN_REQUIRED',
    ]);
  });

  it('rejects a role that is not in the organization', async () => {
    usersById(userOf());
    repository.findRole.mockResolvedValue(null);
    expect(await failure(service.update(actorOf(), 'target', { roleId: 'foreign' }))).toEqual([
      400,
      'INVALID_ROLE',
    ]);
  });

  it('maps an email unique violation to EMAIL_ALREADY_EXISTS without naming an organization', async () => {
    usersById(userOf());
    repository.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    const error = await service
      .update(actorOf(), 'target', { email: 'taken@x.test' })
      .catch((e: HttpException) => e);
    const body = (error as HttpException).getResponse() as { code: string; message: string };
    expect([(error as HttpException).getStatus(), body.code]).toEqual([
      409,
      'EMAIL_ALREADY_EXISTS',
    ]);
    expect(body.message.toLowerCase()).not.toContain('organization');
  });

  describe('manager assignment', () => {
    it('rejects the user as their own manager', async () => {
      usersById(userOf());
      expect(await failure(service.update(actorOf(), 'target', { managerId: 'target' }))).toEqual([
        400,
        'INVALID_MANAGER',
      ]);
    });

    it('rejects a manager outside the organization (not found)', async () => {
      usersById(userOf());
      expect(await failure(service.update(actorOf(), 'target', { managerId: 'foreign' }))).toEqual([
        400,
        'INVALID_MANAGER',
      ]);
    });

    it('rejects an inactive manager', async () => {
      usersById(userOf(), userOf({ id: 'boss', isActive: false }));
      expect(await failure(service.update(actorOf(), 'target', { managerId: 'boss' }))).toEqual([
        400,
        'INVALID_MANAGER',
      ]);
    });

    it('rejects a cycle several levels up (target -> boss -> top -> target)', async () => {
      usersById(
        userOf(),
        userOf({ id: 'boss', managerId: 'top' }),
        userOf({ id: 'top', managerId: 'target' }),
      );
      expect(await failure(service.update(actorOf(), 'target', { managerId: 'boss' }))).toEqual([
        400,
        'INVALID_MANAGER',
      ]);
    });

    it('accepts a valid manager and allows removing the manager with null', async () => {
      usersById(userOf({ managerId: 'boss' }), userOf({ id: 'boss' }), userOf({ id: 'other' }));
      await service.update(actorOf(), 'target', { managerId: 'other' });
      expect(repository.update).toHaveBeenLastCalledWith(
        'target',
        expect.objectContaining({ managerId: 'other' }),
        TX,
      );
      await service.update(actorOf(), 'target', { managerId: null });
      expect(repository.update).toHaveBeenLastCalledWith(
        'target',
        expect.objectContaining({ managerId: null }),
        TX,
      );
    });
  });
});

describe('UsersService.reactivate', () => {
  it('fails with INVALID_MANAGER when the manager is inactive', async () => {
    usersById(
      userOf({ isActive: false, managerId: 'boss' }),
      userOf({ id: 'boss', isActive: false }),
    );
    expect(await failure(service.reactivate(actorOf(), 'target'))).toEqual([
      409,
      'INVALID_MANAGER',
    ]);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('reactivates when the manager is active or absent', async () => {
    usersById(userOf({ isActive: false, managerId: 'boss' }), userOf({ id: 'boss' }));
    await service.reactivate(actorOf(), 'target');
    expect(repository.update).toHaveBeenCalledWith('target', { isActive: true }, TX);
  });
});

describe('UsersService.resetPassword', () => {
  it('refuses to reset your own password', async () => {
    expect(
      await failure(service.resetPassword(actorOf(), 'actor', { temporaryPassword: 'x' })),
    ).toEqual([403, 'CANNOT_RESET_OWN_PASSWORD']);
  });

  it('stores the hash, forces a change and revokes sessions; never logs the password', async () => {
    usersById(userOf());
    await service.resetPassword(actorOf(), 'target', { temporaryPassword: 'super-secret-temp-1' });

    expect(repository.update).toHaveBeenCalledWith(
      'target',
      { passwordHash: 'hashed', mustChangePassword: true },
      TX,
    );
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(TX, 'target', expect.any(Date));
    expect(JSON.stringify(vi.mocked(Logger.prototype.log).mock.calls)).not.toContain(
      'super-secret-temp-1',
    );
    // The audit row is the event alone, written in the same transaction (TX): no password, no hash.
    expect(audit.record).toHaveBeenCalledWith(TX, {
      event: 'user.password_reset',
      entityId: 'target',
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('super-secret-temp-1');
  });

  it('does not report success when the audit insert fails', async () => {
    usersById(userOf());
    audit.record.mockRejectedValue(new Error('audit down'));
    await expect(
      service.resetPassword(actorOf(), 'target', { temporaryPassword: 'super-secret-temp-1' }),
    ).rejects.toThrow('audit down');
  });
});

describe('UsersService.create', () => {
  it('hashes the temporary password and creates the user inside the caller organization', async () => {
    repository.findRole.mockResolvedValue({ id: 'role-rep', name: 'SALES_REP' });
    repository.create.mockResolvedValue(userOf());
    await service.create(actorOf(), {
      email: 'new@x.test',
      firstName: 'N',
      lastName: 'U',
      roleId: 'role-rep',
      temporaryPassword: 'temp-password-123',
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, passwordHash: 'hashed' }),
      TX,
    );
    expect(JSON.stringify(repository.create.mock.calls)).not.toContain('temp-password-123');
  });
});

describe('role assignment escalation', () => {
  const support = actorOf({ role: 'SUPPORT', permissions: ['users:create', 'users:update'] });
  const richRole = {
    id: 'role-rich',
    name: 'SALES_MANAGER',
    permissionKeys: ['users:update', 'reports:read'],
  };
  const dto = {
    email: 'a@x.test',
    firstName: 'A',
    lastName: 'B',
    roleId: 'role-rich',
    temporaryPassword: 'whatever-long-enough',
  };

  it('rejects creating a user with a role holding permissions the caller lacks', async () => {
    repository.findRole.mockResolvedValue(richRole);
    expect(await failure(service.create(support, dto))).toEqual([403, 'CANNOT_GRANT_PERMISSION']);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects assigning such a role to another user, and to oneself', async () => {
    repository.findRole.mockResolvedValue(richRole);
    usersById(userOf(), userOf({ id: 'actor' }));
    expect(await failure(service.update(support, 'target', { roleId: 'role-rich' }))).toEqual([
      403,
      'CANNOT_GRANT_PERMISSION',
    ]);
    // Self role change is refused outright, before the escalation rule is even needed.
    expect(await failure(service.update(support, 'actor', { roleId: 'role-rich' }))).toEqual([
      403,
      'CANNOT_CHANGE_OWN_ROLE',
    ]);
  });

  it('allows assigning a role whose permissions the caller fully holds', async () => {
    repository.findRole.mockResolvedValue({
      id: 'role-small',
      name: 'SUPPORT_LITE',
      permissionKeys: ['users:update'],
    });
    usersById(userOf());
    await service.update(support, 'target', { roleId: 'role-small' });
    expect(repository.update).toHaveBeenCalled();
  });

  it('lets ADMIN assign any role', async () => {
    repository.findRole.mockResolvedValue(richRole);
    usersById(userOf());
    await service.update(actorOf(), 'target', { roleId: 'role-rich' });
    expect(repository.update).toHaveBeenCalled();
  });
});
