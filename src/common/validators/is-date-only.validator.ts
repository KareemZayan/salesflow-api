import { registerDecorator, ValidationOptions } from 'class-validator';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// A real calendar date written YYYY-MM-DD ("2026-02-31" is rejected, not rolled into March).
export function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// The stored value of a date-only column: midnight UTC of that day.
export const dateOnlyToDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

export function IsDateOnly(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: 'isDateOnly',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: { message: '$property must be a valid date written YYYY-MM-DD', ...options },
      validator: { validate: (value: unknown) => isDateOnly(value) },
    });
}
