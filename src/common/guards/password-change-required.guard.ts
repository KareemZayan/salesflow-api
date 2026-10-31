import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ERROR_CODES } from '../constants/error-codes';
import { ALLOW_PASSWORD_CHANGE_KEY } from '../constants/metadata-keys';
import { DomainException } from '../exceptions/domain.exception';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

// An admin-set (temporary) password must be replaced before anything else can be done.
@Injectable()
export class PasswordChangeRequiredGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (!user?.mustChangePassword) return true;

    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_PASSWORD_CHANGE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;
    throw new DomainException(
      ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
      'You must change your password before using the API',
      HttpStatus.FORBIDDEN,
    );
  }
}
