import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { OwnershipScopeService } from './ownership-scope.service';
import { VisibilityScope } from './visibility.types';

// The create/transfer wrappers around OwnershipScopeService.resolveAssignableOwner, shared by every
// owned entity. Plain functions taking the service: no new state, nothing to inject.

// Owner for a new record: the caller by default. Naming yourself needs no check; anyone else goes
// through the assignment rule.
export async function ownerForCreate(
  ownership: OwnershipScopeService,
  actor: AuthenticatedUser,
  requestedOwnerId: string | undefined,
): Promise<string> {
  if (!requestedOwnerId || requestedOwnerId === actor.userId) return actor.userId;
  return ownership.resolveAssignableOwner(await ownership.resolve(actor), requestedOwnerId);
}

// The owner to WRITE on update, or `undefined` when nothing changes. Only a real transfer is
// checked, so an unchanged owner stays as is and a manager can still edit a record whose owner has
// since been deactivated.
export async function ownerForTransfer(
  ownership: OwnershipScopeService,
  scope: VisibilityScope,
  requestedOwnerId: string,
  currentOwnerId: string,
): Promise<string | undefined> {
  if (requestedOwnerId === currentOwnerId) return undefined;
  return ownership.resolveAssignableOwner(scope, requestedOwnerId);
}
