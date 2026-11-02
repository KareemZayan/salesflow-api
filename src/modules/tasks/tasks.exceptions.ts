import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';
import { TaskStatus } from '../../generated/prisma/client';

// A COMPLETED or CANCELLED task is read-only. Reopening it is a status change (POST /tasks/:id/status).
export class TaskClosedException extends DomainException {
  constructor() {
    super(
      ERROR_CODES.TASK_CLOSED,
      'A completed or cancelled task can no longer be edited; reopen it first',
      HttpStatus.CONFLICT,
    );
  }
}

// Two 409s a client handles differently: this change makes no sense from the current status, vs. the
// status moved under the request (GET the task, then decide).
export const rejectedTaskTransition = (from: TaskStatus, to: TaskStatus): DomainException =>
  new DomainException(
    ERROR_CODES.INVALID_TASK_TRANSITION,
    `A task cannot move from ${from} to ${to}`,
    HttpStatus.CONFLICT,
  );

export const concurrentTaskStatusChange = (): DomainException =>
  new DomainException(
    ERROR_CODES.TASK_STATUS_CHANGED,
    'The task status changed in the meantime; reload it and retry',
    HttpStatus.CONFLICT,
  );

// 403, not 404: the caller can see the task, so nothing is hidden by saying why it stays.
export const taskDeleteRestricted = (): DomainException =>
  new DomainException(
    ERROR_CODES.TASK_DELETE_RESTRICTED,
    'Only an admin can delete a completed or cancelled task',
    HttpStatus.FORBIDDEN,
  );

export const invalidReminder = (message: string): DomainException =>
  new DomainException(ERROR_CODES.INVALID_REMINDER, message, HttpStatus.BAD_REQUEST);
