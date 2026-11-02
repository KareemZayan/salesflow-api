import { HttpException } from '@nestjs/common';
import { assertReminder, instantChanged } from './task-reminder';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const codeOf = (run: () => void): unknown => {
  try {
    run();
  } catch (error) {
    return (error as HttpException).getResponse() as { code: string };
  }
  return undefined;
};
const invalidReminder = expect.objectContaining({ code: 'INVALID_REMINDER' });

describe('assertReminder', () => {
  it('accepts no reminder at all', () => {
    expect(() => assertReminder({ dueDate: null, reminderAt: null }, NOW, true)).not.toThrow();
  });

  it('rejects a reminder that is being set in the past or right now', () => {
    expect(codeOf(() => assertReminder({ dueDate: null, reminderAt: at(-1) }, NOW, true))).toEqual(
      invalidReminder,
    );
    expect(codeOf(() => assertReminder({ dueDate: null, reminderAt: NOW }, NOW, true))).toEqual(
      invalidReminder,
    );
  });

  it('does not re-judge an untouched stored reminder against the clock', () => {
    expect(() =>
      assertReminder({ dueDate: null, reminderAt: at(-1000) }, NOW, false),
    ).not.toThrow();
  });

  it('rejects a reminder after the due date, set or stored', () => {
    for (const isBeingSet of [true, false]) {
      expect(
        codeOf(() => assertReminder({ dueDate: at(1000), reminderAt: at(1001) }, NOW, isBeingSet)),
      ).toEqual(invalidReminder);
    }
  });

  it('accepts a reminder exactly at the due date', () => {
    expect(() =>
      assertReminder({ dueDate: at(1000), reminderAt: at(1000) }, NOW, true),
    ).not.toThrow();
  });
});

describe('instantChanged', () => {
  it('compares by value, treating null as a value', () => {
    expect(instantChanged(new Date(5), new Date(5))).toBe(false);
    expect(instantChanged(new Date(5), new Date(6))).toBe(true);
    expect(instantChanged(null, null)).toBe(false);
    expect(instantChanged(null, new Date(5))).toBe(true);
    expect(instantChanged(new Date(5), null)).toBe(true);
  });
});
