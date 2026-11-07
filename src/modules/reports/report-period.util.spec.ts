import { ERROR_CODES } from '../../common/constants/error-codes';
import { buildBuckets, resolveReportRange } from './report-period.util';

const utc = (date: string) => new Date(`${date}T00:00:00.000Z`);
const days = (buckets: { start: Date; end: Date }[]) =>
  buckets.map(({ start, end }) => [start, end].map((d) => d.toISOString().slice(0, 10)).join('..'));

describe('resolveReportRange', () => {
  it('defaults to the last 30 days including today, `to` exclusive (tomorrow, UTC)', () => {
    const range = resolveReportRange({}, new Date('2026-03-10T23:59:59.999Z'));
    expect(range.to).toEqual(utc('2026-03-11'));
    expect(range.from).toEqual(utc('2026-02-09'));
  });

  it('reads dates as UTC midnight and keeps from inclusive, to exclusive', () => {
    const range = resolveReportRange({ from: '2026-01-01', to: '2026-02-01' }, new Date());
    expect(range).toEqual({ from: utc('2026-01-01'), to: utc('2026-02-01') });
  });

  it('with only `to`, counts 30 days back from it', () => {
    const range = resolveReportRange({ to: '2026-03-01' }, new Date());
    expect(range.from).toEqual(utc('2026-01-30'));
  });

  it.each([
    ['equal', { from: '2026-01-01', to: '2026-01-01' }],
    ['reversed', { from: '2026-02-01', to: '2026-01-01' }],
  ])('refuses an empty window (%s)', (_name, query) => {
    expect(() => resolveReportRange(query, new Date())).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({ code: ERROR_CODES.INVALID_REPORT_RANGE }),
      }),
    );
  });

  it('accepts exactly 366 days and refuses 367', () => {
    expect(() =>
      resolveReportRange({ from: '2026-01-01', to: '2027-01-02' }, new Date()),
    ).not.toThrow();
    expect(() =>
      resolveReportRange({ from: '2026-01-01', to: '2027-01-03' }, new Date()),
    ).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({ code: ERROR_CODES.INVALID_REPORT_RANGE }),
      }),
    );
  });
});

describe('buildBuckets', () => {
  it('day: one bucket per day, to exclusive', () => {
    const range = { from: utc('2026-03-01'), to: utc('2026-03-04') };
    expect(days(buildBuckets(range, 'day'))).toEqual([
      '2026-03-01..2026-03-02',
      '2026-03-02..2026-03-03',
      '2026-03-03..2026-03-04',
    ]);
  });

  it('week: starts on Monday, the first and last bucket are clamped to the window', () => {
    // 2026-03-04 is a Wednesday.
    const range = { from: utc('2026-03-04'), to: utc('2026-03-19') };
    expect(days(buildBuckets(range, 'week'))).toEqual([
      '2026-03-04..2026-03-09',
      '2026-03-09..2026-03-16',
      '2026-03-16..2026-03-19',
    ]);
  });

  it('week: a Sunday start makes a one-day first bucket', () => {
    const range = { from: utc('2026-03-08'), to: utc('2026-03-10') };
    expect(days(buildBuckets(range, 'week'))).toEqual([
      '2026-03-08..2026-03-09',
      '2026-03-09..2026-03-10',
    ]);
  });

  it('week: crosses the year boundary without a break (2026-12-28 is a Monday)', () => {
    const range = { from: utc('2026-12-21'), to: utc('2027-01-12') };
    expect(days(buildBuckets(range, 'week'))).toEqual([
      '2026-12-21..2026-12-28',
      '2026-12-28..2027-01-04',
      '2027-01-04..2027-01-11',
      '2027-01-11..2027-01-12',
    ]);
  });

  it('week: a window starting in the last days of a year, ending mid-week', () => {
    const range = { from: utc('2026-12-31'), to: utc('2027-01-05') };
    expect(days(buildBuckets(range, 'week'))).toEqual([
      '2026-12-31..2027-01-04',
      '2027-01-04..2027-01-05',
    ]);
  });

  it('month: calendar months, December rolls into January, February has 28/29 days', () => {
    const range = { from: utc('2027-12-15'), to: utc('2028-03-10') };
    expect(days(buildBuckets(range, 'month'))).toEqual([
      '2027-12-15..2028-01-01',
      '2028-01-01..2028-02-01',
      '2028-02-01..2028-03-01',
      '2028-03-01..2028-03-10',
    ]);
  });

  it.each([
    ['week', '2026-01-07', '2026-11-05'],
    ['month', '2026-01-07', '2026-12-05'],
  ] as const)('%s buckets are contiguous and cover the window exactly', (interval, from, to) => {
    const range = { from: utc(from), to: utc(to) };
    const buckets = buildBuckets(range, interval);
    expect(buckets[0].start).toEqual(range.from);
    expect(buckets[buckets.length - 1].end).toEqual(range.to);
    buckets.slice(1).forEach((bucket, i) => expect(bucket.start).toEqual(buckets[i].end));
  });

  it.each([
    ['day', '2026-01-01', '2026-02-01', 31, true],
    ['day', '2026-01-01', '2026-02-02', 32, false],
    ['month', '2026-01-01', '2027-01-01', 12, true],
    ['month', '2026-01-15', '2027-01-15', 13, false],
    ['week', '2026-01-05', '2027-01-04', 52, true],
    ['week', '2026-01-01', '2027-01-04', 53, true],
    ['week', '2026-01-01', '2027-01-05', 54, false],
  ] as const)(
    '%s cap: %s..%s needs %d buckets, allowed=%s',
    (interval, from, to, count, allowed) => {
      const range = { from: utc(from), to: utc(to) };
      if (allowed) expect(buildBuckets(range, interval)).toHaveLength(count);
      else
        expect(() => buildBuckets(range, interval)).toThrowError(
          expect.objectContaining({
            response: expect.objectContaining({ code: ERROR_CODES.INVALID_REPORT_RANGE }),
          }),
        );
    },
  );
});
