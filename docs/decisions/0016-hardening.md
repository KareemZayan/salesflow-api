# ADR 0016: Hardening (Phase 15)

Status: in progress. 15a (database failure handling) and 15b (required NODE_ENV, production guards,
no-store) are implemented. 15c-15g append their sections here as they land (throttler storage, tenant
isolation and the RLS decision, operations, performance measurement).

Builds on [ADR 0002](0002-tenant-scoping.md) (tenant scoping), [ADR 0004](0004-users-admin.md) (the
advisory locks) and [ADR 0014](0014-audit-logs.md) (fail-closed audit writes).

## 15a. Database failures: what the API answers, and how the pool is sized

### Why

Before 15a, only `P2002`, `P2025` and `P2003` had a mapping. Everything else was `500 INTERNAL_ERROR`,
including a full connection pool, a deadlock and a lost database, none of which are bugs. Every write
path holds a connection inside a transaction while it waits for an advisory lock, so these are the
failures a loaded system actually produces. The pool and every timeout were also on library defaults
(`pg` waits for a free connection **forever**; Prisma's transaction limit is 5 s).

### What Prisma 7 + the pg adapter actually throw (observed, PostgreSQL 16)

Nothing below is assumed. `test/integration/prisma-failures.integration-spec.ts` provokes each case
against a real database and pins the shape, so a driver upgrade that changes one fails a test.

| Situation                                 | Thrown                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No free connection (plain query)          | plain `Error`: `timeout exceeded when trying to connect`                                                                 | **Not a Prisma error.** From `pg`.                                                                                                                                                                                                                                                                                                                             |
| Transaction cannot start (`maxWait`)      | `P2028`, `meta: {}`, "Unable to start a transaction in…"                                                                 |                                                                                                                                                                                                                                                                                                                                                                |
| Transaction ran past its limit            | `P2028`, `meta.timeout` is a number                                                                                      | Query-after-expiry and commit-after-expiry look the same; both are rolled back.                                                                                                                                                                                                                                                                                |
| Use of a finished transaction client      | `P2028`, `meta: {}`, "Transaction already closed"                                                                        | A **code bug** (a leaked `tx`), not load.                                                                                                                                                                                                                                                                                                                      |
| `statement_timeout` / `lock_timeout`      | `P2010` (raw query) or `P2039` (model query); SQLSTATE `57014` / `55P03` in `meta.driverAdapterError.cause.originalCode` | The Prisma code depends on the call path, the SQLSTATE does not.                                                                                                                                                                                                                                                                                               |
| Deadlock                                  | `P2010` (raw) or `P2034` (model); SQLSTATE `40P01`                                                                       | `P2034` is **not** raised for raw queries.                                                                                                                                                                                                                                                                                                                     |
| Serialization failure                     | `P2034`, SQLSTATE `40001`                                                                                                |                                                                                                                                                                                                                                                                                                                                                                |
| Database unreachable                      | `P1001` (single address, DNS failure)                                                                                    | Other shapes, found in 15b when an HTTP test returned 500: raw query `P2010` with cause `kind: DatabaseNotReachable`; a name with several addresses (`localhost`) gives a known-request error with `code: 'ECONNREFUSED'` for model queries and a **bare `AggregateError`** (`code: 'ECONNREFUSED'`) when a transaction starts. All classify as `UNAVAILABLE`. |
| Backend killed / idle-in-transaction kill | plain `Error`: `Client has encountered a connection error…`                                                              | Pool recovers; the next query works.                                                                                                                                                                                                                                                                                                                           |

### The mapping (`common/utils/database-failure.util.ts`, used by `AllExceptionsFilter`)

| Class            | Status | `code`                 | `Retry-After` | Why                                                                                 |
| ---------------- | ------ | ---------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `BUSY`           | 503    | `DATABASE_BUSY`        | 2 s           | Nothing ran; capacity, not a fault. Waiting is the right answer.                    |
| `UNAVAILABLE`    | 503    | `DATABASE_UNAVAILABLE` | 2 s           | Nothing committed; retry after the database is back.                                |
| `TIMEOUT`        | 503    | `DATABASE_TIMEOUT`     | none          | Rolled back, but the same request may take as long again.                           |
| `WRITE_CONFLICT` | 409    | `WRITE_CONFLICT`       | none          | Deadlock/serialization victim, rolled back; an immediate retry is expected to pass. |

`P2028` is split by what it carries (`meta.timeout`, the "Unable to start" message), never mapped as a
whole. "Transaction already closed" and every code we did not observe (`P2024`, `P1002`, `P1008`,
`P1017`) deliberately stay `500`: guessing would hide bugs or lie to clients. Responses carry no driver
text; the cause is logged (the filter logs every 5xx with its stack).

None of these is an `HttpException`, so a domain error is never reinterpreted.

### Timeout semantics and ordering

| Setting (env)                       | Default | Enforced by                | Meaning                                                                    |
| ----------------------------------- | ------- | -------------------------- | -------------------------------------------------------------------------- |
| `DB_POOL_ACQUIRE_TIMEOUT_MS`        | 5000    | pg pool + Prisma `maxWait` | Longest a request waits for a connection, then `DATABASE_BUSY`.            |
| `DB_STATEMENT_TIMEOUT_MS`           | 8000    | PostgreSQL                 | One statement, **including a wait for a lock**.                            |
| `DB_TRANSACTION_TIMEOUT_MS`         | 10000   | Prisma (client)            | Whole interactive transaction.                                             |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 30000   | PostgreSQL                 | Connection idle inside an open transaction (a leaked one keeps its locks). |

Required order, enforced at startup: **statement < transaction < idle-in-transaction**.

The first inequality comes from a measurement, not a preference. A transaction blocked on an advisory
lock was given a 300 ms transaction limit and a holder that kept the lock for 2.5 s: Prisma reported
the timeout after **2.3 s**, and the connection came back only then. Prisma's limit is checked by the
client and cannot interrupt a statement that PostgreSQL is waiting on. With a server-side
`statement_timeout` of 400 ms the same wait failed at the limit and the connection returned at once.
So the statement limit is what bounds a lock wait, and it must fire first. Both cases are pinned in
the integration spec.

`idle > transaction` makes Prisma's own limit fire first in normal cases; the server limit is only the
backstop for a connection that stopped talking.

Release is verified, not assumed: with a pool of one connection, after an expired transaction, a
statement timeout, a deadlock victim and a throwing callback, the next query succeeds, no advisory lock
remains held and no session is left `idle in transaction`. An expired transaction is rolled back
completely, including when the limit is hit at commit.

Not changed: `AUDIT_RETENTION_TX_TIMEOUT_MS` (120 s) still overrides the transaction limit for the
retention job. Its statements are 1,000-row batches, far below the 8 s statement limit.

### Pool sizing (`DB_POOL_MAX`)

Facts: the compose PostgreSQL 16 has `max_connections = 100` and `superuser_reserved_connections = 3`
(read from the running container). One API process owns one pool. BullMQ talks to Redis, not
PostgreSQL.

```
reserve   = 10      3 superuser slots + migrate/seed/org:create at deploy (1-2) + operators and monitoring
budget    = max_connections - reserve = 100 - 10 = 90
pool      = floor(budget / peak_instances)
```

`peak_instances` counts every process that opens a pool, including the extra instance a rolling
deploy starts before the old one stops, and any separate worker process.

| Peak instances  | `DB_POOL_MAX` ceiling | Connections used at the default (10)                |
| --------------- | --------------------- | --------------------------------------------------- |
| 1               | 90                    | 10                                                  |
| 3 (2 + 1 surge) | 30                    | 30                                                  |
| 9               | 10                    | 90 (the default is exactly the limit)               |
| 12              | 7                     | needs 7, or raise `max_connections` / add PgBouncer |

The default of 10 (the `pg` default, so no behaviour change) is safe up to 9 peak instances. It is not
tuned to a measured load: a rule of thumb for a first estimate is `connections ≈ requests/s × average
time a request holds a connection`, so 100 requests/s holding 20 ms each needs about 2. **No load test
has been run; revisit the number with a measured p95 before production.** If `max_connections` is
raised, raise the budget, not the reserve.

### Residual risks (accepted, not fixed here)

1. **One organization can starve the pool.** Writes of one organization queue on its advisory lock, and
   each waiter holds a connection. The wait is now bounded (8 s statement limit; 5 s for everyone else
   to give up with `503`), but a burst on one organization can still use the whole pool for those
   seconds. A per-organization concurrency limit would fix it; it is a design change, not a setting.
2. **Workers share the API pool.** A process with `QUEUE_WORKERS_ENABLED=true` can run up to 41 jobs at
   once (8 queues x concurrency 5, plus sweeps at 1) against a pool of 10. A job that waits more than
   5 s for a connection fails and is retried with backoff, so nothing is lost, but jobs can slow HTTP
   traffic. For production, run workers as their own deployment (`QUEUE_WORKERS_ENABLED=false` on the
   API instances) and count them in `peak_instances`.
3. **Report queries are not measured at volume** (ADR 0015). A report statement longer than 8 s is now
   cancelled with `503 DATABASE_TIMEOUT` instead of running on; the limit is configurable.
4. **Error detection of two cases relies on `pg` message text** (`timeout exceeded when trying to
connect`, `Client has encountered a connection error…`) because `pg` gives them no code. The
   integration spec fails if either text changes.
5. **A client that retries a `WRITE_CONFLICT` must be idempotent-safe**: the transaction was rolled
   back, so a retry is correct, but the API does not retry on the client's behalf.

### Tests

- Unit: `database-failure.util.spec.ts` (every shape, plus the cases that must NOT be classified),
  `all-exceptions.filter.spec.ts` (status, code, `Retry-After`, no driver text, `HttpException`
  untouched), `database-options.spec.ts`, `validate-env.spec.ts` (defaults, ordering rules, bounds).
- Integration (real PostgreSQL): `prisma-failures.integration-spec.ts`, 18 cases, covering every row of
  the observation table, the lock-wait finding, and connection/lock release after each failure kind.

## 15b. Required `NODE_ENV`, production guards, `no-store`

### `NODE_ENV` has no default

`NODE_ENV` used to default to `development`. Everything that distinguishes production hangs on it:
Swagger is mounted unless it is `production`, the Bull Board guard, the pino transport, the seed's
refusal of the placeholder password and of demo data. A deployment that simply forgot the variable
therefore ran as development with every guard off, without a single message. It is now **required** and
must be exactly `development`, `test` or `production` (`Production`, `prod`, `staging`, an empty string
all fail). The error says which of the two it is: "is required; set it to ..." versus "must be one of ...".
The same rule applies to the seed / `org:create` environment (`prisma/seed/seed-env.ts`), which had its
own copy of the default and the same production guards.

Consequences, all checked: the Docker image sets `NODE_ENV=production` (Dockerfile) and the dev
override sets `development`; `.env.example` sets it; the unit, integration and e2e runs get a valid value (Vitest supplies `test`; the e2e and integration
configs also load `.env`, which says `development`), so they need no change.

### Settings that stop the application (production only)

| Setting               | Rule                                     | Why                                                                                                                                            |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_PASSWORD`      | non-empty after trimming                 | Redis holds every organization's queued job payloads and the report cache. An unauthenticated Redis is only acceptable on a developer machine. |
| `QUEUE_BOARD_ENABLED` | must not be `true` (unchanged, ADR 0011) | The board has no authentication.                                                                                                               |

Validation reports every problem in one message, not one per restart. Development and test are
unchanged: no password needed.

**Cost:** the prod-like local run (`docker compose -f docker-compose.yml up`) now needs `REDIS_PASSWORD`
in `.env`, as it already needed a real `SEED_ADMIN_PASSWORD`. Documented in `.env.example` and the README.

### Settings that only warn (production only)

`TRUST_PROXY=false` and an empty `CORS_ORIGINS` are both legitimate (an API reached directly; a
deployment with no browser client), so refusing to start would be wrong. They are forgotten more often
than they are chosen, though, so `configureApp` logs one warning each at startup
(`config/production-warnings.ts`, a pure function). They are silent in development and test, and when
set. **Not covered:** `TRUST_PROXY=true` (every hop trusted, `X-Forwarded-For` spoofable when the API is
directly reachable). It is documented in the README and was not part of the agreed warning set; it is a
candidate for a later guard.

### `Cache-Control: no-store`

Every response under the API prefix, errors included, carries `Cache-Control: no-store`: login and
refresh responses hold tokens, the rest holds tenant data. It is a middleware in `configureApp`, so it
applies before routing (a 404 or a rejected request gets it too).

Deliberately **not** covered: `/health` and `/health/ready` (outside the prefix), Swagger (development
only), and the Bull Board UI (development only, mounted under the prefix but HTML and static assets
rather than API data). The match is by whole path segment, so `/api/v1x/...` is not under the prefix and
`/api/v1/queues-lookalike` is. Mutation-checked: with the middleware removed, the six API cases fail and
the five "not ours" cases still pass.

### HTTP-level database failure tests

`test/e2e/database-failures.e2e-spec.ts` sends real requests and checks status, `Retry-After` and body,
with nothing mocked: database unreachable (503 `DATABASE_UNAVAILABLE`, `Retry-After: 2`, no host or
driver text in the body), pool exhausted (503 `DATABASE_BUSY`, `Retry-After: 2`, and the next request
succeeds), and a request stuck behind an organization lock (503 `DATABASE_TIMEOUT`, **no** `Retry-After`,
the change rolled back, the same request succeeding once the lock is free).

This test found a real gap in 15a: the unreachable case answered 500. The 15a integration spec had used
`127.0.0.1`, which Prisma reports as `P1001`; the test app used `localhost`, which resolves to two
addresses and is reported differently (see the corrected table above). The classifier was extended by
exactly those observed shapes, each pinned in the unit and integration specs. Timeout values and the
other mappings are unchanged.

### Tests

- `validate-env.spec.ts`: missing / unsupported `NODE_ENV`, the production Redis password rule
  (missing, empty, whitespace), development and test unaffected, several production problems reported
  together. `test/unit/seed-env.spec.ts`: the same for the seed.
- `production-warnings.spec.ts`: each warning, both, none when set, none outside production.
- `production-config.e2e-spec.ts` (real application build): production without a Redis password does not
  start; a correct production starts with no warnings and Swagger off; each warning appears alone and
  together; development and test start without noise.
- `cache-control.e2e-spec.ts`, plus a Bull Board case in `queue-board.e2e-spec.ts`.
- A missing `NODE_ENV` is tested at `validateEnv` only: `ConfigModule` also reads `.env`, so deleting the
  variable in an app-level test would silently fall back to the developer's file.
