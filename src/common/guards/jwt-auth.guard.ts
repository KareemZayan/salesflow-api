import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ERROR_CODES } from '../constants/error-codes';
import { IS_PUBLIC_KEY } from '../constants/metadata-keys';
import { DomainException } from '../exceptions/domain.exception';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { TenantContextService } from '../tenant/tenant-context.service';

// Global guard: every route needs a valid access token unless it is marked @Public().
// This is also where the tenant enters the request context: from the verified token, never from input.
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return isPublic ? true : super.canActivate(context);
  }

  // The base signature is generic over the user type; passport hands us what JwtStrategy.validate returned.
  handleRequest<TUser = AuthenticatedUser>(
    err: unknown,
    user: TUser | false | undefined,
    info: unknown,
  ): TUser {
    if (err || !user) {
      const expired = info instanceof Error && info.name === 'TokenExpiredError';
      throw new DomainException(
        expired ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.UNAUTHORIZED,
        expired ? 'Access token has expired' : 'Authentication is required',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.tenantContext.setUser(user as unknown as AuthenticatedUser);
    return user;
  }
}
