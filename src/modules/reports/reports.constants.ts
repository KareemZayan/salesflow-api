export const REPORT_INTERVALS = ['day', 'week', 'month'] as const;
export type ReportInterval = (typeof REPORT_INTERVALS)[number];

// Every report window is [from, to) in UTC calendar days. Without parameters: the last 30 days up to
// and including today (`to` = tomorrow 00:00 UTC, exclusive).
export const DEFAULT_REPORT_WINDOW_DAYS = 30;
export const MAX_REPORT_RANGE_DAYS = 366;

// Revenue by period runs one indexed query per bucket, so the bucket count is capped per interval.
// Counted after calendar alignment: a window that touches 13 months is refused even if it is 366 days.
export const MAX_REPORT_BUCKETS: Record<ReportInterval, number> = {
  day: 31,
  week: 53,
  month: 12,
};

export const REPORT_NAMES = {
  PIPELINE_SUMMARY: 'pipeline-summary',
  WIN_RATE: 'win-rate',
  REVENUE_BY_PERIOD: 'revenue-by-period',
  REVENUE_BY_OWNER: 'revenue-by-owner',
  LEAD_CONVERSION: 'lead-conversion',
  LEADS_BY_SOURCE: 'leads-by-source',
  OVERDUE_TASKS: 'overdue-tasks',
} as const;
export type ReportName = (typeof REPORT_NAMES)[keyof typeof REPORT_NAMES];

// Bumping it abandons every cached report at once (the entries simply expire). Change it whenever a
// response shape changes.
export const REPORT_CACHE_VERSION = 'v1';

// No invalidation: a report may be this stale. `generatedAt` in every response says how old it is.
export const REPORT_TTL_SECONDS = {
  standard: 300,
  // Overdue changes with the clock, so it is kept fresher.
  overdueTasks: 60,
} as const;

// Rates are fractions between 0 and 1 with this many decimals (0.3333), `null` without a denominator.
export const RATE_DECIMALS = 4;
