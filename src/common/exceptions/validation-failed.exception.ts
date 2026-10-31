import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../constants/error-codes';
import { DomainException } from './domain.exception';

export interface FieldError {
  field: string;
  messages: string[];
}

export class ValidationFailedException extends DomainException {
  constructor(details: FieldError[]) {
    super(ERROR_CODES.VALIDATION_FAILED, 'Validation failed', HttpStatus.BAD_REQUEST, details);
  }
}
