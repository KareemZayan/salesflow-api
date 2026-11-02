import { dateOnlyToDate, isDateOnly } from './is-date-only.validator';

describe('isDateOnly', () => {
  it.each(['2026-11-02', '2024-02-29', '1999-12-31'])('accepts %s', (value) => {
    expect(isDateOnly(value)).toBe(true);
  });

  it.each([
    '2026-02-31',
    '2025-02-29',
    '2026-13-01',
    '2026-11-2',
    '2026-11-02T00:00:00Z',
    ' 2026-11-02',
    '',
    20261102,
    null,
    undefined,
  ])('rejects %j', (value) => {
    expect(isDateOnly(value)).toBe(false);
  });

  it('stores midnight UTC of that day', () => {
    expect(dateOnlyToDate('2026-11-02').toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });
});
