import { ValidationError } from 'class-validator';
import { FieldError, ValidationFailedException } from '../exceptions/validation-failed.exception';

// Flattens nested class-validator errors into `{ field: 'a.b[0].c', messages }` entries.
function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own = error.constraints ? [{ field, messages: Object.values(error.constraints) }] : [];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

export const validationExceptionFactory = (errors: ValidationError[]): ValidationFailedException =>
  new ValidationFailedException(flatten(errors));
