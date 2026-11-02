import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';
import { LeadStatus } from '../../generated/prisma/client';

// Two different 409s, so a frontend can react differently (ADR 0008):
//  - LEAD_ALREADY_CONVERTED: the lead is final. Stop editing; show it read-only.
//  - INVALID_STATUS_TRANSITION: this status change is not possible (now). GET the lead and offer
//    the moves that are.
export class LeadAlreadyConvertedException extends DomainException {
  constructor() {
    super(
      ERROR_CODES.LEAD_ALREADY_CONVERTED,
      'A converted lead can no longer be changed',
      HttpStatus.CONFLICT,
    );
  }
}

export class InvalidLeadStatusTransitionException extends DomainException {
  constructor(message: string) {
    super(ERROR_CODES.INVALID_STATUS_TRANSITION, message, HttpStatus.CONFLICT);
  }
}

// The two answers to "this status change did not happen", shared by the callbacks of
// applyStatusTransition. Both are about the caller's own, visible lead.
export function rejectedLeadTransition(from: LeadStatus, to: LeadStatus): DomainException {
  return from === LeadStatus.CONVERTED
    ? new LeadAlreadyConvertedException()
    : new InvalidLeadStatusTransitionException(`A lead cannot move from ${from} to ${to}`);
}

export class InvalidConversionOptionsException extends DomainException {
  constructor(message: string) {
    super(ERROR_CODES.INVALID_CONVERSION_OPTIONS, message, HttpStatus.BAD_REQUEST);
  }
}

export function rejectedLeadConversion(from: LeadStatus): DomainException {
  return from === LeadStatus.CONVERTED
    ? new LeadAlreadyConvertedException()
    : new InvalidLeadStatusTransitionException(
        `Only a QUALIFIED lead can be converted (this lead is ${from})`,
      );
}

export function concurrentLeadStatusChange(actual: LeadStatus): DomainException {
  return actual === LeadStatus.CONVERTED
    ? new LeadAlreadyConvertedException()
    : new InvalidLeadStatusTransitionException(
        `The lead status changed in the meantime (it is now ${actual}); reload the lead and retry`,
      );
}
