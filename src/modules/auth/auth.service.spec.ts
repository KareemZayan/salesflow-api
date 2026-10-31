import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { AuthRepository, StoredRefreshTokenRecord } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const NOW = new Date('2026-06-01T12:00:00Z');
const GRACE_MS = 10_000;

const repository = {
  findLoginCandidate: vi.fn(),
  findAuthContext: vi.fn(),
  findPasswordHash: vi.fn(),
  markLogin: vi.fn(),
  findRefreshToken: vi.fn(),
  createRefreshToken: vi.fn(),
  rotateRefreshToken: vi.fn(),
  hasActiveToken: vi.fn(),
  revokeFamily: vi.fn(),
  replacePassword: vi.fn(),
};

const passwords = new PasswordService();
const tokens = new TokenService(
  { signAsync: vi.fn().mockResolvedValue('access.jwt') } as unknown as JwtService,
  {
    getOrThrow: () => ({
      auth: {
        accessSecret: 's'.repeat(32),
        accessExpiresInSeconds: 900,
        refreshExpiresInMs: 86_400_000,
        refreshReuseGraceMs: GRACE_MS,
      },
    }),
  } as unknown as ConfigService,
);
const service = new AuthService(repository as unknown as AuthRepository, passwords, tokens);

const stored = (overrides: Partial<StoredRefreshTokenRecord> = {}): StoredRefreshTokenRecord => ({
  id: 'rt-1',
  organizationId: 'org-1',
  userId: 'user-1',
  familyId: 'family-1',
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  revokedAt: null,
  user: { isActive: true, mustChangePassword: false, organization: { isActive: true } },
  ...overrides,
});

const failure = async (promise: Promise<unknown>): Promise<[number, string]> => {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return [http.getStatus(), (http.getResponse() as { code: string }).code];
  }
  throw new Error('expected the call to fail');
};

describe('AuthService', () => {
  let passwordHash: string;
  const caller: AuthenticatedUser = {
    userId: 'user-1',
    organizationId: 'org-1',
    role: 'SALES_REP',
    permissions: ['leads:read'],
    mustChangePassword: false,
  };

  beforeAll(async () => {
    await passwords.onModuleInit();
    passwordHash = await passwords.hash('the-right-password');
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    Object.values(repository).forEach((fn) => fn.mockReset());
  });

  afterEach(() => vi.useRealTimers());

  describe('login', () => {
    const candidate = (overrides = {}) => ({
      id: 'user-1',
      organizationId: 'org-1',
      passwordHash,
      isActive: true,
      mustChangePassword: false,
      organization: { isActive: true },
      ...overrides,
    });
    const credentials = { email: 'rep@example.com', password: 'the-right-password' };

    it('returns a token pair, starts a new family and records the login', async () => {
      repository.findLoginCandidate.mockResolvedValue(candidate({ mustChangePassword: true }));

      const result = await service.login(credentials);

      expect(result).toMatchObject({
        accessToken: 'access.jwt',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: true,
      });
      const [saved] = repository.createRefreshToken.mock.calls[0];
      expect(saved).toMatchObject({ userId: 'user-1', organizationId: 'org-1' });
      expect(saved.familyId).toEqual(expect.any(String));
      expect(saved.tokenHash).toBe(tokens.hashRefreshToken(result.refreshToken));
      expect(repository.markLogin).toHaveBeenCalledWith('user-1', NOW);
    });

    it('runs a dummy hash check for an unknown email and answers like a wrong password', async () => {
      repository.findLoginCandidate.mockResolvedValue(null);
      const dummy = vi.spyOn(passwords, 'verifyDummy');

      expect(await failure(service.login(credentials))).toEqual([
        401,
        ERROR_CODES.INVALID_CREDENTIALS,
      ]);
      expect(dummy).toHaveBeenCalledWith(credentials.password);
      dummy.mockRestore();
    });

    it.each([
      ['wrong password', candidate(), { password: 'a-wrong-password' }],
      ['inactive user', candidate({ isActive: false }), {}],
      ['inactive organization', candidate({ organization: { isActive: false } }), {}],
    ])('gives the same answer for %s', async (_label, user, override) => {
      repository.findLoginCandidate.mockResolvedValue(user);

      expect(await failure(service.login({ ...credentials, ...override }))).toEqual([
        401,
        ERROR_CODES.INVALID_CREDENTIALS,
      ]);
      expect(repository.createRefreshToken).not.toHaveBeenCalled();
      expect(repository.markLogin).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('rejects an unknown token', async () => {
      repository.findRefreshToken.mockResolvedValue(null);
      expect(await failure(service.refresh('nope'))).toEqual([
        401,
        ERROR_CODES.INVALID_REFRESH_TOKEN,
      ]);
    });

    it('rotates inside the same family and returns a new pair', async () => {
      repository.findRefreshToken.mockResolvedValue(stored());
      repository.rotateRefreshToken.mockResolvedValue(true);

      const result = await service.refresh('old-token');

      const [current, successor, at] = repository.rotateRefreshToken.mock.calls[0];
      expect(current.id).toBe('rt-1');
      expect(successor).toMatchObject({ userId: 'user-1', familyId: 'family-1' });
      expect(at).toEqual(NOW);
      expect(successor.tokenHash).toBe(tokens.hashRefreshToken(result.refreshToken));
      expect(result.accessToken).toBe('access.jwt');
    });

    it('rejects an expired token without rotating', async () => {
      repository.findRefreshToken.mockResolvedValue(
        stored({ expiresAt: new Date(NOW.getTime() - 1) }),
      );
      expect(await failure(service.refresh('t'))).toEqual([401, ERROR_CODES.INVALID_REFRESH_TOKEN]);
      expect(repository.rotateRefreshToken).not.toHaveBeenCalled();
    });

    it.each([
      ['user', { isActive: false, mustChangePassword: false, organization: { isActive: true } }],
      [
        'organization',
        { isActive: true, mustChangePassword: false, organization: { isActive: false } },
      ],
    ])('revokes the family and answers 401 when the %s is inactive', async (_label, user) => {
      repository.findRefreshToken.mockResolvedValue(stored({ user }));

      expect(await failure(service.refresh('t'))).toEqual([401, ERROR_CODES.INVALID_REFRESH_TOKEN]);
      expect(repository.revokeFamily).toHaveBeenCalledWith('family-1', NOW);
      expect(repository.rotateRefreshToken).not.toHaveBeenCalled();
    });

    it('answers 409 (not 401) and keeps the family when a token was rotated inside the grace window', async () => {
      repository.hasActiveToken.mockResolvedValue(true);
      repository.findRefreshToken.mockResolvedValue(
        stored({ revokedAt: new Date(NOW.getTime() - GRACE_MS + 1) }),
      );

      expect(await failure(service.refresh('t'))).toEqual([
        409,
        ERROR_CODES.TOKEN_ROTATED_RECENTLY,
      ]);
      expect(repository.revokeFamily).not.toHaveBeenCalled();
    });

    it('answers 401 (not 409) for a recent replay when the family has already ended', async () => {
      repository.findRefreshToken.mockResolvedValue(stored({ revokedAt: NOW }));
      repository.hasActiveToken.mockResolvedValue(false);

      expect(await failure(service.refresh('t'))).toEqual([401, ERROR_CODES.INVALID_REFRESH_TOKEN]);
      expect(repository.revokeFamily).not.toHaveBeenCalled();
    });

    it('treats a replay after the grace window as theft and revokes the family', async () => {
      repository.findRefreshToken.mockResolvedValue(
        stored({ revokedAt: new Date(NOW.getTime() - GRACE_MS - 1) }),
      );

      expect(await failure(service.refresh('t'))).toEqual([401, ERROR_CODES.TOKEN_REUSED]);
      expect(repository.revokeFamily).toHaveBeenCalledWith('family-1', NOW);
    });

    it('answers 409 when it loses the rotation race to a concurrent request', async () => {
      repository.findRefreshToken
        .mockResolvedValueOnce(stored())
        .mockResolvedValueOnce(stored({ revokedAt: NOW }));
      repository.hasActiveToken.mockResolvedValue(true);
      repository.rotateRefreshToken.mockResolvedValue(false);

      expect(await failure(service.refresh('t'))).toEqual([
        409,
        ERROR_CODES.TOKEN_ROTATED_RECENTLY,
      ]);
      expect(repository.revokeFamily).not.toHaveBeenCalled();
    });

    it('rejects when the lost-race token is gone entirely', async () => {
      repository.findRefreshToken.mockResolvedValueOnce(stored()).mockResolvedValueOnce(null);
      repository.rotateRefreshToken.mockResolvedValue(false);

      expect(await failure(service.refresh('t'))).toEqual([401, ERROR_CODES.INVALID_REFRESH_TOKEN]);
    });
  });

  describe('logout', () => {
    it('revokes the whole family of a known token', async () => {
      repository.findRefreshToken.mockResolvedValue(stored());
      await service.logout('t');
      expect(repository.revokeFamily).toHaveBeenCalledWith('family-1', NOW);
    });

    it('is idempotent for an unknown token', async () => {
      repository.findRefreshToken.mockResolvedValue(null);
      await expect(service.logout('t')).resolves.toBeUndefined();
      expect(repository.revokeFamily).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    const dto = { currentPassword: 'the-right-password', newPassword: 'a-brand-new-password' };

    it('rejects a wrong current password', async () => {
      repository.findPasswordHash.mockResolvedValue(passwordHash);
      expect(
        await failure(
          service.changePassword(caller, { ...dto, currentPassword: 'wrong-one-here' }),
        ),
      ).toEqual([400, ERROR_CODES.CURRENT_PASSWORD_INCORRECT]);
      expect(repository.replacePassword).not.toHaveBeenCalled();
    });

    it('rejects a new password equal to the current one', async () => {
      repository.findPasswordHash.mockResolvedValue(passwordHash);
      expect(
        await failure(service.changePassword(caller, { ...dto, newPassword: dto.currentPassword })),
      ).toEqual([400, ERROR_CODES.WEAK_PASSWORD]);
    });

    it('applies the password policy', async () => {
      repository.findPasswordHash.mockResolvedValue(passwordHash);
      expect(
        await failure(service.changePassword(caller, { ...dto, newPassword: 'short' })),
      ).toEqual([400, ERROR_CODES.WEAK_PASSWORD]);
    });

    it('replaces the hash, revokes old sessions and returns a pair in a new family', async () => {
      repository.findPasswordHash.mockResolvedValue(passwordHash);

      const result = await service.changePassword({ ...caller, mustChangePassword: true }, dto);

      const [userId, newHash, successor, at] = repository.replacePassword.mock.calls[0];
      expect(userId).toBe('user-1');
      expect(await passwords.verify(newHash, dto.newPassword)).toBe(true);
      expect(successor.familyId).toEqual(expect.any(String));
      expect(successor.tokenHash).toBe(tokens.hashRefreshToken(result.refreshToken));
      expect(at).toEqual(NOW);
      expect(result.mustChangePassword).toBe(false);
    });
  });

  describe('me', () => {
    it('returns the profile with role and permissions', async () => {
      repository.findAuthContext.mockResolvedValue({
        id: 'user-1',
        organizationId: 'org-1',
        email: 'rep@example.com',
        firstName: 'Rae',
        lastName: 'Rep',
        mustChangePassword: false,
      });

      expect(await service.me(caller)).toEqual({
        id: 'user-1',
        organizationId: 'org-1',
        email: 'rep@example.com',
        firstName: 'Rae',
        lastName: 'Rep',
        role: 'SALES_REP',
        permissions: ['leads:read'],
        mustChangePassword: false,
      });
    });
  });
});
