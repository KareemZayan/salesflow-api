import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';

// A PATCH with no fields is a client bug, not "nothing to do": answer 400 so it is noticed. A PATCH
// whose values merely equal the stored ones is fine and stays a 200 (the body is not empty).
// `undefined` counts as absent, matching how the validation pipe leaves omitted fields.
export function assertHasChanges(dto: object): void {
  if (Object.values(dto).some((value) => value !== undefined)) return;
  throw new DomainException(
    ERROR_CODES.EMPTY_UPDATE,
    'Send at least one field to update',
    HttpStatus.BAD_REQUEST,
  );
}
