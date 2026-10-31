import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ERROR_CODES } from '../../../common/constants/error-codes';
import { DomainException } from '../../../common/exceptions/domain.exception';
import { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface';
import { APP_CONFIG_KEY, AppConfig } from '../../../config/app.config';
import { JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER } from '../auth.constants';
import { AuthRepository } from '../auth.repository';
import { AccessTokenPayload } from '../token.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly repository: AuthRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.getOrThrow<AppConfig>(APP_CONFIG_KEY).auth.accessSecret,
      // Pinned: never trust the `alg` header of an incoming token.
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      ignoreExpiration: false,
    });
  }

  // Runs on every request, after the signature checked out. The signature only proves the token
  // was issued; the database decides whether it still counts (deactivated user or organization,
  // changed role or permissions), so those changes apply to still-valid tokens at once.
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const record =
      typeof payload.sub === 'string' ? await this.repository.findAuthContext(payload.sub) : null;
    // The org claim must match the user's real organization: it is the tenant source of truth.
    if (
      !record ||
      !record.isActive ||
      !record.organization.isActive ||
      record.organizationId !== payload.org
    ) {
      throw new DomainException(
        ERROR_CODES.UNAUTHORIZED,
        'Authentication is required',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return {
      userId: record.id,
      organizationId: record.organizationId,
      role: record.role.name,
      permissions: record.role.permissions.map(({ permission }) => permission.key),
      mustChangePassword: record.mustChangePassword,
    };
  }
}
