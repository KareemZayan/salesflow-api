# SalesFlow CRM

Multi-tenant CRM backend built with NestJS, TypeScript (strict), PostgreSQL, Prisma, Redis and BullMQ.

> Status: under construction. See `PROJECT_STATUS.md` for the current phase and `CLAUDE.md` for the architecture rules.

## Prerequisites

- Node.js >= 22 (LTS)
- pnpm

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm start:dev
```

The API is served under `/api/v1`.

`NODE_ENV` has **no default** and must be `development`, `test` or `production`; the app (and the seed) stop at
startup if it is missing or anything else. `.env.example` already sets it for local work.

## Scripts

| Script           | Description              |
| ---------------- | ------------------------ |
| `pnpm start:dev` | Run in watch mode        |
| `pnpm build`     | Compile to `dist/`       |
| `pnpm lint`      | ESLint                   |
| `pnpm typecheck` | TypeScript type check    |
| `pnpm test`      | Unit tests (Vitest)      |
| `pnpm test:cov`  | Unit tests with coverage |

## Authentication

Users are created by an admin (no public sign-up). `POST /api/v1/auth/login` returns a 15-minute access token (`Authorization: Bearer ...`) and an opaque, single-use refresh token (in the JSON body). Design and rationale: [ADR 0003](docs/decisions/0003-authentication.md).

- **Refresh**: `POST /auth/refresh` rotates the refresh token. Sending an already-used token again within `REFRESH_REUSE_GRACE_SECONDS` (default 10) answers **409 `TOKEN_ROTATED_RECENTLY`**: the session is still valid, so do **not** log the user out; retry with the token from the latest successful response. Replaying a token after that window answers 401 `TOKEN_REUSED` and revokes the whole session.
- **Logout**: `POST /auth/logout` with the refresh token in the body; always 204.
- **Change password**: revokes all refresh tokens and returns a new pair. Access tokens issued earlier stay valid until they expire.
- **Rate limiting**: login is limited per IP **and** per IP + email (`THROTTLE_AUTH_IP_LIMIT`, `THROTTLE_AUTH_LIMIT`, per `THROTTLE_TTL_SECONDS`), every other route per IP (`THROTTLE_LIMIT`). IPv6 clients count per /64. The counters live in Redis and are shared by every instance (see "Rate limiting" below).

### Behind a reverse proxy (`TRUST_PROXY`)

The rate limiter keys on the client IP. Behind nginx, a cloud load balancer or similar, every request appears to come from the proxy unless Express is told to trust it, and all clients then share one rate-limit bucket.

| Setup                                                                   | `TRUST_PROXY`                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| API reachable directly (default, local dev, the bundled Docker Compose) | `false`                                                    |
| One reverse proxy / load balancer in front                              | `1`                                                        |
| Several hops, or a known proxy network                                  | hop count, or a subnet list such as `loopback, 10.0.0.0/8` |

Never set `true` while the API is directly reachable: any client could then spoof `X-Forwarded-For` to dodge the limit and to write a fake IP into the audit log. Prefer the exact number of proxy hops (`1`, `2`, ...). With `NODE_ENV=production`, `TRUST_PROXY=true` logs a warning at startup saying so.

With `NODE_ENV=production`, the API logs a warning at startup when `TRUST_PROXY` is `false` (easy to forget
behind a proxy) or `CORS_ORIGINS` is empty (browsers on other origins are blocked). Both are valid
settings, so they warn instead of stopping the app. Responses under `/api/v1` carry `Cache-Control: no-store`
(they hold tokens and tenant data); `/health` and the development-only Swagger and Bull Board UIs do not.

## Rate limiting

Counters are kept in Redis (`THROTTLE_STORAGE=redis`, the default), so N instances share one limit instead of
allowing N times as many attempts. It is a **sliding window**: a request counts for `THROTTLE_TTL_SECONDS`
after it is made. `THROTTLE_STORAGE=memory` (per process, lost on restart) exists for development and tests
only and is **refused when `NODE_ENV=production`**. Design and numbers: [ADR 0016](docs/decisions/0016-hardening.md).

**Which limit applies where:**

| Route                          | Limit                                                                                                                                          | Tracker                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `POST /auth/login`             | **both**, decided together: `THROTTLE_AUTH_IP_LIMIT` (default 120) per client IP, and `THROTTLE_AUTH_LIMIT` (default 10) per client IP + email | IP (an IPv6 /64), and IP + email |
| `refresh`, `change-password`   | `THROTTLE_AUTH_LIMIT` per IP, per route                                                                                                        | IP                               |
| `logout` and every other route | `THROTTLE_LIMIT` (default 100) per IP                                                                                                          | IP                               |

Login is cut off when _either_ limit is reached, with `429` and a `Retry-After-login` header. The two are
decided in one atomic Redis operation: a refused attempt creates no Redis key, and an attempt refused for
one account does not use up the IP's budget, so one hammered account cannot lock out the other people behind
a shared address. A single IP can therefore create at most `THROTTLE_AUTH_IP_LIMIT` account keys per window
however many emails it tries. The same email from another IP is a separate bucket (an attacker cannot lock
a victim out of their own IP). `THROTTLE_AUTH_IP_LIMIT` counts every admitted attempt, successful or not;
raise it if many people behind one address (an office, a mobile carrier's NAT) sign in at once.
Memory mode has only the per-account limit on login.

**When Redis cannot be consulted** (down, slow, or the script failing) the limiter never silently turns off:

| Route                                                      | While Redis is unavailable                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login, refresh, change-password                            | **Fail closed**: `503` with code `THROTTLE_UNAVAILABLE` and `Retry-After`. The request never reaches the handler, so no password is checked.                                                                                 |
| **Logout** and every other route (the `default` throttler) | Fall back to a limiter in that instance's memory, with the same limit. **Never unlimited, but N times weaker with N instances** until Redis is back. Logout keeps working, so a session can still be ended during an outage. |

After 3 failures in a row a circuit breaker treats Redis as down for 5 seconds, so requests are answered at once
instead of each waiting for the 250 ms timeout; then one request probes it. The outage and the recovery are
each logged once, and the number of requests refused is in the recovery line. `/health/ready` reports the
throttle storage (`throttle`) through its own connection.

Redis must run with `maxmemory-policy noeviction` (BullMQ needs it too): an evicting Redis can drop a counter
early and let requests through. The API logs a warning at startup if it is not (and skips the check, without
failing, if Redis refuses `CONFIG`).

## Audit logs

Who changed what, and when: [ADR 0014](docs/decisions/0014-audit-logs.md). Audit rows are **not** queued:
each one is written in the same database transaction as the audited change (`AuditService.record(tx, ...)`),
so if the audit insert fails the change fails with it, and a rolled-back change leaves no row. That includes
sign-in: while the audit table is unavailable nobody can log in. The table is append-only (a trigger blocks
UPDATE and DELETE; only the retention job may delete, see the table below). The trigger is defence in depth
at application level, not protection against a database administrator. Administrators read the trail with
`GET /api/v1/audit-logs` (`audit-logs:read`, cursor pagination, filters); the response includes IP address
and user agent, which no other endpoint exposes. Failed logins are only written to the structured log.
**Retention (730 days by default) is a legal / contractual decision to confirm before production.**

## Background jobs

Asynchronous work runs on [BullMQ](https://docs.bullmq.io/) (Redis). Design and guarantees:
[ADR 0011](docs/decisions/0011-queue-and-notifications.md) (queue foundation, notifications) and
[ADR 0012](docs/decisions/0012-scheduled-jobs.md) (scheduled jobs) and
[ADR 0013](docs/decisions/0013-activities.md) (the `activities` queue: system timeline entries, one job
per target record, idempotent on a dedupe key; a lost event is a missing entry, not an error). This
section only says how to use and operate it; the numbers live in code, not here.

| What                                                                             | Where                                                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Queue names, default job options (attempts, backoff, history trimming), timeouts | `src/infrastructure/queue/queue.constants.ts`                                           |
| Schedules (cadence of each sweep)                                                | `src/jobs/sweeps/organization-sweeps.ts`                                                |
| Alert batch cap per job                                                          | `TASK_ALERT_BATCH_LIMIT` in `src/modules/tasks/tasks.constants.ts`                      |
| Notification retention                                                           | `NOTIFICATION_RETENTION_DAYS` in `src/modules/notifications/notifications.constants.ts` |
| Refresh-token clean-up                                                           | `src/modules/auth/auth.constants.ts`                                                    |
| Audit log retention (permanent delete)                                           | `AUDIT_RETENTION_DAYS` in `src/modules/audit-logs/audit-logs.constants.ts`              |

How it fits together: domain events and schedules create jobs; every job payload carries an
`organizationId` and nothing personal (ids only), and a worker runs it inside that tenant. Schedules are
BullMQ job schedulers, so they fire once per cluster, not once per API instance. Handlers are idempotent
(BullMQ delivers at least once).

### Configuration

| Variable                   | Meaning                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_HOST`, `REDIS_PORT` | `<redis host>`, `<redis port>`                                                                                                                |
| `REDIS_PASSWORD`           | `<password>`, or empty for no authentication (local only)                                                                                     |
| `QUEUE_PREFIX`             | `<prefix>` in front of every queue key; use a different one per environment sharing a Redis                                                   |
| `QUEUE_WORKERS_ENABLED`    | `<true or false>`: `true` = this process also runs the workers and registers the schedules; `false` = it only enqueues (an API-only instance) |
| `QUEUE_BOARD_ENABLED`      | `<true or false>`, default `false`: local-development queue UI, see below                                                                     |

Run at least one instance with workers enabled, or nothing is processed and nothing is scheduled.

### Redis in production

- `REDIS_PASSWORD` is **required** when `NODE_ENV=production`: the application refuses to start with an
  empty or whitespace-only value. That includes the prod-like `docker compose -f docker-compose.yml up`,
  which needs it in `.env` too. The bundled `docker-compose.yml` starts Redis with authentication when it
  is set (and its healthcheck authenticates), and the API reads the same variable.
- The base compose file publishes **no** Redis port: Redis is reachable on the compose network only. The
  dev override (`docker-compose.override.yml`) publishes it on `127.0.0.1`, never on all interfaces.
  Keep it that way on any host that is reachable from outside.
- `GET /health/ready` pings Redis through the BullMQ connection (a real round-trip, not an open-port
  check) next to the database check, so an instance that cannot reach Redis is reported not ready.

### Graceful shutdown

On `SIGTERM`/`SIGINT` (`app.enableShutdownHooks()` in `src/main.ts`) the workers stop taking new jobs and
let the running job finish, for a bounded time (`WORKER_CLOSE_TIMEOUT_MS`;
`QueueWorkersService.onModuleDestroy`). A job cut off by the forced close is re-delivered by BullMQ
(stalled-job recovery) and is safe to run again because handlers are idempotent.

### Failed jobs

A job is retried with exponential backoff (`DEFAULT_JOB_OPTIONS`). When its attempts run out it stays in the
queue's **failed** set for a limited time, then is trimmed.

- **What the logs say:** queue, job id, attempt and the error class only. Payloads and driver messages are
  never logged, because they can contain personal data. The full reason is stored on the failed job in
  Redis (`failedReason`).
- **Find one:** the job id of a notification is its `dedupeKey` (`<event>-<recordId>-<epoch ms>`); a
  per-organization job id is `<sweep>-<organizationId>-<time bucket>`. In local development open Bull Board
  (below). Elsewhere, read the job hash with `redis-cli` (keys are `<QUEUE_PREFIX>:<queue>:<job id>`).
- **Retry:** fix the cause first, then retry the failed job (Bull Board in development; re-adding the same
  job elsewhere). It is safe: the notification insert is keyed on `dedupeKey`, and the scheduled jobs use
  conditional markers, so a retry can never double-notify. Scheduled sweeps are not retried at all; the
  next tick does the same work.
- There is no dead-letter queue or alerting yet (Phase 15).

### Bull Board (local development only)

Bull Board is a UI to look at queues, failed jobs and retry them.

- **It has no authentication** and shows the job payloads of **every organization**. Use it on your own
  machine only. Never expose it, and never put it behind a public port or a shared development server.
- It is **off by default**. It is mounted only when `QUEUE_BOARD_ENABLED=true` **and** `NODE_ENV` is not
  `production`, at `http://localhost:<PORT>/api/v1/queues`.
- `NODE_ENV=production` with the flag on **stops the application at startup** with a clear error; the flag
  is never silently ignored. The default `docker-compose.yml` does not set it. If your local `.env` has it
  on, the prod-like compose run will refuse to start until you turn it off.
- Its CSP is relaxed for that path only; every other path keeps the strict policy.
- A production-grade version (behind a platform-level credential, not an organization admin login) is a
  Phase 15 item.

### Known limits

Domain events reach the queue best effort after the database commit: if the process dies in between, that
notification is lost. A transactional outbox is a separate, still open decision (ADR 0011). Time-based
alerts (reminders, overdue) are not affected: they are recomputed from the task rows.
