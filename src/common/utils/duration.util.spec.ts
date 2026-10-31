import { DURATION_PATTERN, parseDurationMs } from './duration.util';

describe('parseDurationMs', () => {
  it.each([
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it.each(['', '0m', '15', 'm', '1w', '-5m', '1.5h', ' 5m'])('rejects "%s"', (input) => {
    expect(DURATION_PATTERN.test(input)).toBe(false);
    expect(() => parseDurationMs(input)).toThrow(/Invalid duration/);
  });
});
