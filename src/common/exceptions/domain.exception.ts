import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../constants/error-codes';

// Base for business-rule errors. Subclasses fix their own code and status, e.g.
// `class LeadAlreadyConvertedException extends DomainException`. The global filter turns the
// `code` (and optional `details`) into the standard error body.
export class DomainException extends HttpException {
  constructor(code: ErrorCode | string, message: string, status: HttpStatus, details?: unknown) {
    super({ code, message, details }, status);
  }
}
