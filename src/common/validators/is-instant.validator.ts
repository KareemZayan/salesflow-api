import { registerDecorator, ValidationOptions } from 'class-validator';
import { isDateOnly } from './is-date-only.validator';

// date-time, then a mandatory offset: `Z` or `+hh:mm` / `-hh:mm`. Without one, "2026-12-01T09:00:00"
// would be read in the server's zone, which is exactly the ambiguity this validator exists to refuse.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

// A point in time written as ISO 8601 WITH a timezone offset ("2026-12-01T09:00:00+02:00" or "...Z").
// A calendar date alone is rejected: a due date or reminder is an instant, not a day.
export function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !INSTANT.test(value)) return false;
  // `new Date()` rolls "2026-02-31" into March instead of failing, so the calendar day is checked
  // on its own; the rest (hours, minutes, offset) is caught by the Date parse.
  return isDateOnly(value.slice(0, 10)) && !Number.isNaN(new Date(value).getTime());
}

// The stored value: the same instant, held as a UTC `Date` (Postgres `timestamptz`/UTC).
export const instantToDate = (value: string): Date => new Date(value);

export function IsInstant(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'isInstant',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: {
        message:
          '$property must be an ISO 8601 date-time with a timezone, e.g. 2026-12-01T09:00:00Z',
        ...options,
      },
      validator: { validate: (value: unknown) => isInstant(value) },
    });
}
