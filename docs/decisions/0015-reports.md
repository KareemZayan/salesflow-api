# ADR 0015: Reports and analytics (Phase 14)

Status: accepted (Phase 14). Builds on [ADR 0002](0002-tenant-scoping.md) (tenant scoping),
[ADR 0005](0005-roles-and-visibility.md) (visibility), [ADR 0009](0009-pipelines-and-deals.md)
(money, stages) and [ADR 0010](0010-tasks.md) (the one definition of overdue).

## What exists

Seven read-only JSON endpoints under `GET /api/v1/reports/...`, all needing `reports:read` (ADMIN and
SALES_MANAGER; a rep gets 403, unchanged from the seed; no permission or seed change):

| Endpoint                                              | Answers                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `pipeline-summary?pipelineId`                         | deals per stage (default pipeline), money per currency        |
| `win-rate?from&to`                                    | won / lost counts, `winRate`, money per currency              |
| `revenue/by-period?from&to&interval=day\|week\|month` | WON deals per bucket, every currency in every bucket          |
| `revenue/by-owner?from&to`                            | WON deals per owner, money per currency                       |
| `lead-conversion?from&to`                             | leads created in the window and how many are CONVERTED        |
| `leads-by-source?from&to`                             | the same cohort per `LeadSource`, zeros included              |
| `overdue-tasks`                                       | open tasks past their due date, per assignee and per priority |

The shape is the usual one: controller (HTTP only) -> `ReportsService` (scope, cache, shaping) ->
`ReportsRepository` (Prisma aggregates only). The repository uses the tenant client (`PRISMA_TENANT`)
like every other repository; it does not import another module's repository.

## Visibility and tenancy

- `OwnershipScopeService.resolve(actor)` once per request, then `applyVisibility()` is ANDed into the
  `where` of every aggregate (deals and leads by `ownerId`, tasks by `assigneeId`). The database
  aggregates only rows the caller may see; nothing is filtered after a total was built.
- The tenant extension scopes `groupBy` like any read: `organizationId` is added, and soft-deleted
  deals and leads are excluded (tested). `organizationId` is never accepted as a parameter (a 400
  through `forbidNonWhitelisted`, tested).
- Overdue uses `overdueWhere(now)` from `tasks.constants.ts`: no second definition. A test checks that
  the report total equals `GET /tasks?overdue=true`. Drill-down is that list, with `assigneeId`.
- Names (owner, assignee) are read for the ids that came out of the aggregate. Deactivated users are
  included, their numbers are in the totals.

## Money

- Every sum is `GROUP BY currency` in SQL: two currencies are never added, and there is no conversion
  (ADR 0009). Amounts are two-decimal strings (`Decimal` -> `toFixed(2)`); an aggregate over no rows
  is `0.00`.
- Counts are separate fields (`dealCount` on the report, the stage, the bucket and every currency
  entry), so a `0.00` deal is counted and the frontend decides whether "not priced yet" matters.
- `revenue/by-period` lists **every currency seen in the window in every bucket** (`0.00` / `0`
  where the bucket had none), so a chart has no holes and no currency is merged.

## Periods (all UTC)

- `from` and `to` are calendar days `YYYY-MM-DD` read as UTC midnight. **`from` is inclusive, `to` is
  exclusive.** Defaults: `to` = tomorrow (so today is included), `from` = 30 days before `to`.
- Revenue and win rate use `Deal.closedAt`; lead reports use `Lead.createdAt`.
- Buckets are calendar-aligned: days, **weeks starting on Monday**, months starting on the 1st. They
  are clamped to the window, so the first and last bucket may be partial; `start`/`end` is exactly
  what was counted. Weeks that cross a year end are one bucket (tested for 2026-12-28 -> 2027-01-04).
- Limits (error `400 INVALID_REPORT_RANGE`): `from` before `to`, at most **366 days**, and at most
  **31 days / 53 weeks / 12 months** of buckets (counted after alignment, so a window that touches 13
  months is refused even if it is 365 days). A day-written query that is not a real date is a
  `400 VALIDATION_FAILED`.
- **Lead conversion is a cohort**: leads _created_ in the window and, of those, the ones CONVERTED
  _now_. The rate is always between 0 and 1 (`null` for an empty cohort, never 0%). A lead created
  last month and converted today counts in last month's cohort.
- Rates (`winRate`, `conversionRate`) are fractions with four decimals, `null` without a denominator.

## Period buckets: one indexed `groupBy` per bucket (no raw SQL)

Prisma cannot group by date. The alternative, `$queryRaw` with `date_trunc`, would be one query but
would run outside the tenant extension on tenant tables. The chosen design runs one `groupBy` per
bucket, sequentially, on the existing `Deal (organizationId, status, closedAt)` index; the bucket caps
above bound it to at most 53 small queries (`ReportsRepository.wonRevenue`). The cost of a cache miss
is acceptable because the result is cached (below).

## Cache (cache-aside, Redis)

`CacheService` (`infrastructure/cache`) wraps `ioredis`: `remember(key, ttl, compute)`.

- **Key**: `reports:v1:<organizationId>:<report>:<scopeFingerprint>:<paramsHash>`.
  `scopeFingerprint` is `all` (admin) or `owners-` + a hash of the sorted owner ids, so a manager's
  team and an admin can never read each other's entry, and two managers with different teams do not
  share one either. `paramsHash` hashes the **resolved** parameters (dates after defaults, the real
  pipeline id after the default pipeline was looked up, the interval), so a default window rolls over
  with the day. `organizationId` comes from the authenticated user only. The key prefix is the queue
  prefix, so a test app or a second environment sharing a Redis stays apart.
- **TTL, no invalidation**: 5 minutes; 60 seconds for overdue tasks. A report may be that stale;
  `generatedAt` says exactly how old. `v1` in the key is bumped when a response shape changes.
- **`generatedAt`** is set INSIDE the cached computation, so a hit returns the instant the numbers
  were computed. For overdue tasks it is also the clock "overdue" was judged against.
- **Fails open.** Redis down, slow (500 ms bound), or a corrupt value: a `warn` (message only, never
  the key or the value; one line per outage) and the report is computed from the database. Commands
  fail at once while disconnected (no offline queue) and are skipped entirely during a known outage.
  Errors of the computation itself (a 404 for an unknown pipeline) are not cached.
- Only plain JSON (strings, numbers, arrays) is stored, so a hit and a miss answer with the same shape.
- **Dropped on purpose**: the scheduled cache refresh / warm-up job planned in CLAUDE.md section 10.
  Keys are per user scope, so warming them for organizations nobody opens costs more than it saves;
  TTL expiry refreshes lazily. Cache invalidation and the transactional outbox stay deferred.

## Index: `Lead (organizationId, createdAt)` (migration `add_lead_created_at_index`)

Added because the plan showed a need, not by habit. Measured on a temporary copy of `Lead` (same
columns and indexes, no foreign keys; 400k rows, 300k in the target organization over two years, 40
owners, `EXPLAIN (ANALYZE, BUFFERS)`):

| Query (cohort: 30-day window)              | Plan before                          | Plan after                                                                  |
| ------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------- |
| **admin scope** (no owner filter)          | **Seq Scan, 6,154 buffers, 47.8 ms** | Bitmap Index Scan, 826 buffers, 6.6 ms                                      |
| manager scope (6 owners)                   | already the owner-led index, 8.7 ms  | unchanged (6.0 ms)                                                          |
| admin scope, 366-day window (half the org) | Seq Scan, 69.8 ms                    | not improved (the window is not selective); not a reason for a second index |

The admin cohort scanned the **whole table, every tenant's leads**, so one organization's report cost
grows with all the others' data. The new index is the only change; the cost is one more btree on
`Lead` writes. The other report queries use existing indexes by design (`Deal (org, status,
closedAt)` for won/lost/revenue, `Deal (org, pipelineId, stageId, status)` for the pipeline summary);
they were not measured at volume in this phase, and the overdue-tasks query was not measured either.

## Known limits (accepted)

- The queries of one report are not one snapshot: a write between two of them can make a bucket and
  the report total differ by that write. Reports are statistics, not ledgers.
- Up to 5 minutes stale (60 seconds for overdue tasks), by design.
- A rep gets 403. Giving reps their own numbers needs `reports:read` in `SALES_REP` (a seed change
  that existing organizations would not receive, since the seed no longer re-grants permissions).
- CSV export is a future addition (CLAUDE.md section 9).
