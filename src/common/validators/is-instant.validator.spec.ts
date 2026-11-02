import { instantToDate, isInstant } from './is-instant.validator';

describe('isInstant', () => {
  it.each([
    '2026-12-01T09:00:00Z',
    '2026-12-01T09:00:00.123Z',
    '2026-12-01T09:00Z',
    '2026-12-01T09:00:00+02:00',
    '2026-12-01T09:00:00-05:30',
  ])('accepts %s', (value) => {
    expect(isInstant(value)).toBe(true);
  });

  it.each([
    '2026-12-01',
    '2026-12-01T09:00:00',
    '2026-12-01 09:00:00Z',
    '2026-12-01T09:00:00+0200',
    '2026-02-31T09:00:00Z',
    '2026-12-01T25:00:00Z',
    'tomorrow',
    '',
    1_700_000_000_000,
    null,
    undefined,
  ])('rejects %s', (value) => {
    expect(isInstant(value)).toBe(false);
  });

  it('stores the same instant whatever offset was sent', () => {
    expect(instantToDate('2026-12-01T11:00:00+02:00').toISOString()).toBe(
      '2026-12-01T09:00:00.000Z',
    );
  });
});
