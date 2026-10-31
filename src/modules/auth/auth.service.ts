import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { TOKEN_TYPE } from './auth.constants';
import { AuthRepository, NewRefreshTokenData, StoredRefreshTokenRecord } from './auth.repository';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { MeResponseDto } from './dto/me-response.dto';
import { TokenResponseDto } from './dto/token-response.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

interface SessionOwner {
  userId: string;
  organizationId: string;
  mustChangePassword: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async login({ email, password }: LoginDto): Promise<TokenResponseDto> {
    const user = await this.repository.findLoginCandidate(email);
    if (!user) {
      // Same work as a real check, so response time does not reveal whether the email exists.
      await this.passwords.verifyDummy(password);
      throw this.invalidCredentials();
    }

    const passwordMatches = await this.passwords.verify(user.passwordHash, password);
    // Inactive accounts get the same answer as a wrong password: no account-state oracle.
    if (!passwordMatches || !user.isActive || !user.organization.isActive) {
      throw this.invalidCredentials();
    }

    const session = await this.startSession(
      {
        userId: user.id,
        organizationId: user.organizationId,
        mustChangePassword: user.mustChangePassword,
      },
      randomUUID(),
    );
    await this.repository.markLogin(user.id, new Date());
    return session;
  }

  async refresh(rawToken: string): Promise<TokenResponseDto> {
    const now = new Date();
    const stored = await this.repository.findRefreshToken(this.tokens.hashRefreshToken(rawToken));
    if (!stored) throw this.invalidRefreshToken();
    if (stored.revokedAt) return this.rejectRevoked(stored.familyId, stored.revokedAt, now);
    if (stored.expiresAt <= now) throw this.invalidRefreshToken();

    // A deactivated user or organization must not be able to keep a session alive by refreshing.
    if (!stored.user.isActive || !stored.user.organization.isActive) {
      await this.repository.revokeFamily(stored.familyId, now);
      throw this.invalidRefreshToken();
    }

    const successor = this.tokens.createRefreshToken(now);
    const rotated = await this.repository.rotateRefreshToken(
      stored,
      this.toRefreshRecord(stored.userId, stored.organizationId, stored.familyId, successor),
      now,
    );
    if (!rotated) return this.rejectLostRace(stored, rawToken, now);

    return this.respond(
      {
        userId: stored.userId,
        organizationId: stored.organizationId,
        mustChangePassword: stored.user.mustChangePassword,
      },
      successor.raw,
    );
  }

  // Idempotent: an unknown or already-revoked token is not an error (the goal state, "this session
  // is gone", already holds), and answering differently would let callers probe for valid tokens.
  async logout(rawToken: string): Promise<void> {
    const stored = await this.repository.findRefreshToken(this.tokens.hashRefreshToken(rawToken));
    if (stored) await this.repository.revokeFamily(stored.familyId, new Date());
  }

  async changePassword(
    user: AuthenticatedUser,
    { currentPassword, newPassword }: ChangePasswordDto,
  ): Promise<TokenResponseDto> {
    const currentHash = await this.repository.findPasswordHash(user.userId);
    if (!currentHash || !(await this.passwords.verify(currentHash, currentPassword))) {
      throw new DomainException(
        ERROR_CODES.CURRENT_PASSWORD_INCORRECT,
        'The current password is incorrect',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (newPassword === currentPassword) {
      throw new DomainException(
        ERROR_CODES.WEAK_PASSWORD,
        'The new password must be different from the current one',
        HttpStatus.BAD_REQUEST,
      );
    }
    this.passwords.assertAcceptable(newPassword);

    const now = new Date();
    const fresh = this.tokens.createRefreshToken(now);
    // A new family: the caller keeps working, every other session (any device) is signed out.
    // Access tokens already issued stay valid until they expire (JWT_ACCESS_EXPIRES_IN); only
    // refresh tokens can be revoked.
    await this.repository.replacePassword(
      user.userId,
      await this.passwords.hash(newPassword),
      this.toRefreshRecord(user.userId, user.organizationId, randomUUID(), fresh),
      now,
    );
    return this.respond(
      { userId: user.userId, organizationId: user.organizationId, mustChangePassword: false },
      fresh.raw,
    );
  }

  async me(user: AuthenticatedUser): Promise<MeResponseDto> {
    const record = await this.repository.findAuthContext(user.userId);
    if (!record) throw this.invalidCredentials();
    return {
      id: record.id,
      organizationId: record.organizationId,
      email: record.email,
      firstName: record.firstName,
      lastName: record.lastName,
      role: user.role,
      permissions: user.permissions,
      mustChangePassword: record.mustChangePassword,
    };
  }

  private async startSession(owner: SessionOwner, familyId: string): Promise<TokenResponseDto> {
    const refresh = this.tokens.createRefreshToken(new Date());
    await this.repository.createRefreshToken(
      this.toRefreshRecord(owner.userId, owner.organizationId, familyId, refresh),
    );
    return this.respond(owner, refresh.raw);
  }

  private async respond(owner: SessionOwner, refreshToken: string): Promise<TokenResponseDto> {
    return {
      accessToken: await this.tokens.signAccessToken(owner.userId, owner.organizationId),
      refreshToken,
      tokenType: TOKEN_TYPE,
      expiresIn: this.tokens.accessExpiresInSeconds,
      mustChangePassword: owner.mustChangePassword,
    };
  }

  private toRefreshRecord(
    userId: string,
    organizationId: string,
    familyId: string,
    next: ReturnType<TokenService['createRefreshToken']>,
  ): NewRefreshTokenData {
    return { userId, organizationId, familyId, tokenHash: next.hash, expiresAt: next.expiresAt };
  }

  // A revoked token showing up again is either a harmless race or theft:
  // - revoked a moment ago while the family still has a live successor: the client fired two
  //   refreshes with the same token, or retried after a lost response. The session is fine, so
  //   409 (not 401: the client must not log the user out) and it retries with the latest token.
  // - revoked a moment ago but the family is dead (logout, reuse burn, password change): 401, since
  //   telling the client to retry with its latest token would loop forever.
  // - revoked longer ago: someone replays an old token, so the whole family is burned.
  private async rejectRevoked(familyId: string, revokedAt: Date, now: Date): Promise<never> {
    if (now.getTime() - revokedAt.getTime() <= this.tokens.reuseGraceMs) {
      if (!(await this.repository.hasActiveToken(familyId, now))) throw this.invalidRefreshToken();
      throw new DomainException(
        ERROR_CODES.TOKEN_ROTATED_RECENTLY,
        'This refresh token was just used; retry with the token from the latest response',
        HttpStatus.CONFLICT,
      );
    }
    await this.repository.revokeFamily(familyId, now);
    throw new DomainException(
      ERROR_CODES.TOKEN_REUSED,
      'Refresh token reuse detected; sign in again',
      HttpStatus.UNAUTHORIZED,
    );
  }

  // We lost the rotation race: someone else just revoked this token. Re-read to learn when.
  private async rejectLostRace(
    stored: StoredRefreshTokenRecord,
    rawToken: string,
    now: Date,
  ): Promise<never> {
    const current = await this.repository.findRefreshToken(this.tokens.hashRefreshToken(rawToken));
    if (!current?.revokedAt) throw this.invalidRefreshToken();
    return this.rejectRevoked(stored.familyId, current.revokedAt, now);
  }

  private invalidCredentials(): DomainException {
    return new DomainException(
      ERROR_CODES.INVALID_CREDENTIALS,
      'Invalid email or password',
      HttpStatus.UNAUTHORIZED,
    );
  }

  private invalidRefreshToken(): DomainException {
    return new DomainException(
      ERROR_CODES.INVALID_REFRESH_TOKEN,
      'The refresh token is invalid or expired',
      HttpStatus.UNAUTHORIZED,
    );
  }
}
