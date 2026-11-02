import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';

// A WON or LOST deal is read-only. Reopening it is a move to an open stage (POST /deals/:id/move).
export class DealClosedException extends DomainException {
  constructor() {
    super(
      ERROR_CODES.DEAL_CLOSED,
      'A closed deal can no longer be edited; reopen it by moving it to an open stage',
      HttpStatus.CONFLICT,
    );
  }
}

// Two 409s a client handles differently: this move makes no sense (same stage), vs. the deal moved
// under the request (GET it, then decide).
export class InvalidStageMoveException extends DomainException {
  constructor() {
    super(ERROR_CODES.INVALID_STAGE_MOVE, 'The deal is already in this stage', HttpStatus.CONFLICT);
  }
}

export class DealStageChangedException extends DomainException {
  constructor() {
    super(
      ERROR_CODES.DEAL_STAGE_CHANGED,
      'The deal was moved in the meantime; reload it and retry',
      HttpStatus.CONFLICT,
    );
  }
}

export const lostReasonRequired = () =>
  new DomainException(
    ERROR_CODES.LOST_REASON_REQUIRED,
    'A lostReason is required to move a deal to a Lost stage',
    HttpStatus.BAD_REQUEST,
  );

export const lostReasonNotAllowed = () =>
  new DomainException(
    ERROR_CODES.LOST_REASON_NOT_ALLOWED,
    'A lostReason can only be sent when moving a deal to a Lost stage',
    HttpStatus.BAD_REQUEST,
  );
