import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../constants/error-codes';
import { DomainException } from './domain.exception';

// The one 404 for "no such record for this caller": missing, deleted, another organization and not
// visible all look the same, so the answer never confirms that a record exists.
export function resourceNotFound(entity: string): DomainException {
  return new DomainException(
    ERROR_CODES.RESOURCE_NOT_FOUND,
    `${entity} not found`,
    HttpStatus.NOT_FOUND,
  );
}
