import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../constants/error-codes';
import { ADMIN_ROLE_NAME } from '../constants/roles';
import { DomainException } from '../exceptions/domain.exception';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

// The one escalation rule, shared by Roles (grant/edit permissions) and Users (assign a role):
// nobody may hand out power they do not hold themselves. ADMIN holds everything by definition.
export function assertMayGrant(actor: AuthenticatedUser, permissionKeys: Iterable<string>): void {
  if (actor.role === ADMIN_ROLE_NAME) return;
  const held = new Set(actor.permissions);
  const missing = [...new Set(permissionKeys)].filter((key) => !held.has(key));
  if (missing.length > 0) {
    throw new DomainException(
      ERROR_CODES.CANNOT_GRANT_PERMISSION,
      'You cannot grant or manage permissions you do not hold yourself',
      HttpStatus.FORBIDDEN,
      { missing },
    );
  }
}
