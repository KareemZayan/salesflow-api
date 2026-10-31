import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES } from '../constants/error-codes';
import {
  ALLOW_PASSWORD_CHANGE_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
} from '../constants/metadata-keys';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { TenantContextService } from '../tenant/tenant-context.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordChangeRequiredGuard } from './password-change-required.guard';
import { PermissionsGuard } from './permissions.guard';
import { RolesGuard } from './roles.guard';

const user = (overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  userId: 'u1',
  organizationId: 'o1',
  role: 'SALES_REP',
  permissions: ['leads:read', 'leads:create'],
  mustChangePassword: false,
  ...overrides,
});

// Reflector stub: metadata is looked up by key, as it would be on a decorated handler.
const context = (metadata: Record<string, unknown>, requestUser?: AuthenticatedUser) => {
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
  const executionContext = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user: requestUser }) }),
  } as unknown as ExecutionContext;
  return { reflector, executionContext };
};

const statusAndCode = (fn: () => unknown): [number, string] => {
  try {
    fn();
  } catch (error) {
    const http = error as HttpException;
    return [http.getStatus(), (http.getResponse() as { code: string }).code];
  }
  throw new Error('expected the guard to throw');
};

describe('RolesGuard', () => {
  const run = (metadata: Record<string, unknown>, requestUser?: AuthenticatedUser) => {
    const { reflector, executionContext } = context(metadata, requestUser);
    return () => new RolesGuard(reflector).canActivate(executionContext);
  };

  it('allows routes without @Roles', () => {
    expect(run({}, user())()).toBe(true);
  });

  it('allows a user whose role is listed', () => {
    expect(run({ [ROLES_KEY]: ['ADMIN', 'SALES_REP'] }, user())()).toBe(true);
  });

  it('answers 403 FORBIDDEN for another role, or no user at all', () => {
    expect(statusAndCode(run({ [ROLES_KEY]: ['ADMIN'] }, user()))).toEqual([
      403,
      ERROR_CODES.FORBIDDEN,
    ]);
    expect(statusAndCode(run({ [ROLES_KEY]: ['ADMIN'] }))).toEqual([403, ERROR_CODES.FORBIDDEN]);
  });
});

describe('PermissionsGuard', () => {
  const run = (metadata: Record<string, unknown>, requestUser?: AuthenticatedUser) => {
    const { reflector, executionContext } = context(metadata, requestUser);
    return () => new PermissionsGuard(reflector).canActivate(executionContext);
  };

  it('requires ALL listed permissions', () => {
    expect(run({ [PERMISSIONS_KEY]: ['leads:read', 'leads:create'] }, user())()).toBe(true);
    expect(
      statusAndCode(run({ [PERMISSIONS_KEY]: ['leads:read', 'leads:delete'] }, user())),
    ).toEqual([403, ERROR_CODES.FORBIDDEN]);
  });

  it('allows routes without @Permissions', () => {
    expect(run({}, user())()).toBe(true);
  });
});

describe('PasswordChangeRequiredGuard', () => {
  const run = (metadata: Record<string, unknown>, requestUser?: AuthenticatedUser) => {
    const { reflector, executionContext } = context(metadata, requestUser);
    return () => new PasswordChangeRequiredGuard(reflector).canActivate(executionContext);
  };

  it('lets a normal user and public routes (no user) through', () => {
    expect(run({}, user())()).toBe(true);
    expect(run({})()).toBe(true);
  });

  it('blocks a flagged user except on routes that allow it', () => {
    expect(statusAndCode(run({}, user({ mustChangePassword: true })))).toEqual([
      403,
      ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
    ]);
    expect(run({ [ALLOW_PASSWORD_CHANGE_KEY]: true }, user({ mustChangePassword: true }))()).toBe(
      true,
    );
  });
});

describe('JwtAuthGuard', () => {
  const setUser = vi.fn();
  const build = (metadata: Record<string, unknown>) => {
    const { reflector, executionContext } = context(metadata);
    const tenantContext = { setUser } as unknown as TenantContextService;
    return { guard: new JwtAuthGuard(reflector, tenantContext), executionContext };
  };

  it('skips authentication for @Public routes', () => {
    const { guard, executionContext } = build({ [IS_PUBLIC_KEY]: true });
    expect(guard.canActivate(executionContext)).toBe(true);
  });

  it('puts the verified user in the tenant context', () => {
    const authenticated = user();
    expect(build({}).guard.handleRequest(null, authenticated, undefined)).toBe(authenticated);
    expect(setUser).toHaveBeenCalledWith(authenticated);
  });

  it('answers 401 UNAUTHORIZED when there is no valid user', () => {
    const { guard } = build({});
    expect(
      statusAndCode(() => guard.handleRequest(null, false, new Error('No auth token'))),
    ).toEqual([401, ERROR_CODES.UNAUTHORIZED]);
  });

  it('answers 401 TOKEN_EXPIRED so clients know to refresh', () => {
    const { guard } = build({});
    const expired = Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' });
    expect(statusAndCode(() => guard.handleRequest(null, false, expired))).toEqual([
      401,
      ERROR_CODES.TOKEN_EXPIRED,
    ]);
  });
});
