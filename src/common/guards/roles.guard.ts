import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ERROR_CODES } from '../constants/error-codes';
import { ROLES_KEY } from '../constants/metadata-keys';
import { DomainException } from '../exceptions/domain.exception';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

// @Roles('ADMIN', 'SALES_MANAGER'): the user's single role must be one of the listed ones.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (user && required.includes(user.role)) return true;
    throw new DomainException(
      ERROR_CODES.FORBIDDEN,
      'You do not have the role required for this action',
      HttpStatus.FORBIDDEN,
    );
  }
}
