import { dateOnlyToDate } from '../../common/validators/is-date-only.validator';
import {
  DEFAULT_REPORT_WINDOW_DAYS,
  MAX_REPORT_BUCKETS,
  MAX_REPORT_RANGE_DAYS,
  ReportInterval,
} from './reports.constants';
import { invalidReportRange } from './reports.exceptions';

const DAY_MS = 86_400_000;

// Everything here is UTC and pure: the clock is a parameter, so period rules are testable.
export interface ReportRange {
  from: Date; // inclusive
  to: Date; // exclusive
}

export interface ReportBucket {
  start: Date; // inclusive
  end: Date; // exclusive
}

const startOfUtcDay = (instant: Date): Date =>
  new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));

// `from` is inclusive and `to` exclusive, both midnight UTC. Defaults: `to` = tomorrow 00:00 (so
// today is included), `from` = 30 days before `to`.
export function resolveReportRange(input: { from?: string; to?: string }, now: Date): ReportRange {
  const to = input.to ? dateOnlyToDate(input.to) : new Date(startOfUtcDay(now).getTime() + DAY_MS);
  const from = input.from
    ? dateOnlyToDate(input.from)
    : new Date(to.getTime() - DEFAULT_REPORT_WINDOW_DAYS * DAY_MS);

  if (from.getTime() >= to.getTime()) {
    throw invalidReportRange('`from` must be before `to` (`to` is exclusive)');
  }
  if ((to.getTime() - from.getTime()) / DAY_MS > MAX_REPORT_RANGE_DAYS) {
    throw invalidReportRange(`The window may not be longer than ${MAX_REPORT_RANGE_DAYS} days`);
  }
  return { from, to };
}

// The next calendar boundary after `at` (which is always a midnight): the next day, the next Monday
// or the 1st of the next month. Date.UTC rolls December into January, so year ends need no case.
function nextBoundary(at: Date, interval: ReportInterval): Date {
  if (interval === 'day') return new Date(at.getTime() + DAY_MS);
  if (interval === 'week') {
    const sinceMonday = (at.getUTCDay() + 6) % 7;
    return new Date(at.getTime() + (7 - sinceMonday) * DAY_MS);
  }
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

// Calendar-aligned buckets (days, Monday-based weeks, months) clamped to the window, so the first
// and last bucket may be partial: a bucket's `start`/`end` is exactly what was counted.
export function buildBuckets(range: ReportRange, interval: ReportInterval): ReportBucket[] {
  const buckets: ReportBucket[] = [];
  for (let start = range.from; start.getTime() < range.to.getTime();) {
    const boundary = nextBoundary(start, interval);
    const end = boundary.getTime() < range.to.getTime() ? boundary : range.to;
    buckets.push({ start, end });
    start = end;
  }
  const cap = MAX_REPORT_BUCKETS[interval];
  if (buckets.length > cap) {
    throw invalidReportRange(
      `A "${interval}" report may span at most ${cap} ${interval}s; this window needs ${buckets.length}`,
    );
  }
  return buckets;
}
