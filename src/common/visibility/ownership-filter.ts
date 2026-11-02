import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';
import { VisibilityScope } from './visibility.types';

// The where-fragment for one owner column, e.g. `{ ownerId: { in: [...] } }`. Empty for `all`.
// `in` never matches NULL, so records without an owner are visible to admins only (see ADR 0005).
export function ownerWhere(scope: VisibilityScope, field = 'ownerId'): Record<string, unknown> {
  return scope.kind === 'all' ? {} : { [field]: { in: scope.ownerIds } };
}

// Combines the caller's own filter with visibility using AND, so neither can overwrite or widen the
// other (a plain spread would let a `where.ownerId` from a query string replace the scope).
// `W` is the repository's Prisma `WhereInput`; the fragment only ever targets one owner column
// that exists on it, hence the cast.
export function applyVisibility<W extends object>(
  where: W | undefined,
  scope: VisibilityScope,
  field = 'ownerId',
): { AND: W[] } {
  const fragment = ownerWhere(scope, field) as W;
  return { AND: where ? [where, fragment] : [fragment] };
}

// For single-record access: a record the caller may not see answers 404, never 403, so its
// existence is not revealed. `ownerId` is null for ownerless records.
export function assertVisible(scope: VisibilityScope, ownerId: string | null): void {
  if (scope.kind === 'all') return;
  if (ownerId !== null && scope.ownerIds.includes(ownerId)) return;
  throw new DomainException(
    ERROR_CODES.RESOURCE_NOT_FOUND,
    'Resource not found',
    HttpStatus.NOT_FOUND,
  );
}
