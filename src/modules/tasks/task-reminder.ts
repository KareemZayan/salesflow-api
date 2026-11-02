import { invalidReminder } from './tasks.exceptions';

// The rules a reminder must satisfy, in one place for create and update. Both values are the ones
// the task WILL have (current merged with the request), so editing only the due date is judged
// against the reminder already stored.
//  - `reminderAt` must not be after `dueDate` (a reminder after the deadline is meaningless).
//  - `reminderAt` must be in the future when it is being SET or CHANGED (`isBeingSet`): a reminder
//    in the past can never fire at its time, so it is a client mistake rather than a backlog entry
//    (unlike a past `dueDate`, which is allowed). An untouched stored reminder is never re-judged
//    against the clock, so editing a task after its reminder time still works.
export function assertReminder(
  task: { dueDate: Date | null; reminderAt: Date | null },
  now: Date,
  isBeingSet: boolean,
): void {
  const { dueDate, reminderAt } = task;
  if (!reminderAt) return;
  if (isBeingSet && reminderAt.getTime() <= now.getTime()) {
    throw invalidReminder('reminderAt must be in the future');
  }
  if (dueDate && reminderAt.getTime() > dueDate.getTime()) {
    throw invalidReminder('reminderAt must not be after dueDate');
  }
}

// Whether two nullable instants differ (Dates compare by value, not by reference).
export const instantChanged = (before: Date | null, after: Date | null): boolean =>
  before?.getTime() !== after?.getTime();
