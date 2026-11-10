import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../constants/error-codes';
import { DomainException } from './domain.exception';

// Thrown when the rate limiter cannot be consulted for a route where "unknown" must not mean
// "allowed" (login and the other auth routes). The message deliberately names no infrastructure.
// `retryAfterSeconds` becomes the Retry-After header (all-exceptions.filter.ts).
export class ThrottleUnavailableException extends DomainException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      ERROR_CODES.THROTTLE_UNAVAILABLE,
      'Request limiting is temporarily unavailable, please retry shortly',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
