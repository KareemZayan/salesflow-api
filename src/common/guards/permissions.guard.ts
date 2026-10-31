import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ERROR_CODES } from '../constants/error-codes';
import { PERMISSIONS_KEY } from '../constants/metadata-keys';
import { DomainException } from '../exceptions/domain.exception';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

// @Permissions('leads:read', 'leads:update'): the user needs ALL listed permissions.
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (user && required.every((permission) => user.permissions.includes(permission))) return true;
    throw new DomainException(
      ERROR_CODES.FORBIDDEN,
      'You do not have permission to perform this action',
      HttpStatus.FORBIDDEN,
    );
  }
}
