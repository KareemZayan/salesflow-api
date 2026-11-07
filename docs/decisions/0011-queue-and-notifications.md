# ADR 0011: Queue foundation and notifications

Status: accepted (Phase 12a). 12b (task reminders, overdue scheduler, refresh-token cleanup) and 12c
(Bull Board, README) build on it and add their own sections here.

## Technology

BullMQ 6 on the compose Redis 7, through `@nestjs/bullmq` 11 and `ioredis` 5.

- `@nestjs/bullmq` is pinned to **^11**: v12 is ESM-only (same reason as Nest 12, terminus and jwt).
- `bullmq` resolved to 6.5.3, not the newest 6.5.4: pnpm's release-age gate refuses a version that is
  only hours old, and pnpm offered to add a `minimumReleaseAgeExclude` entry. That bypass was removed
  on purpose; do not add it.
- `msgpackr-extract` (an optional native speed-up of BullMQ) has its build script ignored; BullMQ
  falls back to pure JS. Approve it in `pnpm-workspace.yaml` only if profiling ever asks for it.

## Layout

| Piece                                          | Where                    | Role                                                                    |
| ---------------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `QueueModule`, `JobQueueService`               | `infrastructure/queue/`  | The only producer entry point (Adapter over BullMQ): options + timeout  |
| `QueueWorkersService`                          | `infrastructure/queue/`  | Starts a `Worker` per registered handler, sets the tenant, logs failure |
| `NotificationsModule` (API, listener, factory) | `modules/notifications/` | Inbox endpoints, domain event -> job                                    |
| `NotificationsProcessor`                       | `jobs/notifications/`    | Worker-side handler (idempotent insert)                                 |

Handlers register themselves with `QueueWorkersService` in their own `onModuleInit`, and workers start in
`onApplicationBootstrap`, so the infrastructure module never imports a feature module (no cycle).
`@Processor` from `@nestjs/bullmq` is deliberately **not** used: its options are fixed at decoration time,
and this app needs the worker switch (below) to come from validated config.

## Configuration

| Variable                | Default     | Meaning                                                                     |
| ----------------------- | ----------- | --------------------------------------------------------------------------- |
| `QUEUE_PREFIX`          | `salesflow` | Key prefix of every queue; `[A-Za-z0-9_-]` only (BullMQ rejects `:` in ids) |
| `QUEUE_WORKERS_ENABLED` | `true`      | `false` = producer-only process (an API instance that runs no workers)      |
| `REDIS_PASSWORD`        | empty       | Blank = no authentication                                                   |
| `TEST_REDIS_PORT`       | none        | e2e only: host port of the compose Redis (`REDIS_HOST_PORT`, 6380 locally)  |

## Job rules (apply to every job, now and in 12b)

- Payload extends `TenantJobPayload` (`organizationId`) and is plain JSON. `QueueWorkersService` runs the
  handler inside `TenantContextService.run(payload.organizationId, ...)`, so the Prisma scoping
  extension applies. A payload without a tenant fails with `UnrecoverableError` (never retried).
- Defaults (`DEFAULT_JOB_OPTIONS`): 5 attempts, exponential backoff from 2 s (2, 4, 8, 16 s),
  `removeOnComplete` 1 h / 1000 jobs, `removeOnFail` 7 days / 5000 jobs.
- Handlers must be **idempotent**: BullMQ is at-least-once (retry, stalled-job recovery).
- Failure logs carry the queue, job id, attempt and the **error class only**. The payload can hold
  personal data and some driver messages echo query values; the full reason stays on the failed job
  in Redis (`failedReason`).

### Failed-job handling

A job that exhausts its attempts stays in the queue's **failed** set for 7 days (or 5000 jobs). To look
at one: its id is the notification's `dedupeKey` (`<event>-<recordId>-<epoch ms>`); `failedReason`
holds the cause. Bull Board (12c) will list them. To re-run one after fixing the cause, retry it from
there; the insert is idempotent, so a retry can never double-notify. There is no automatic dead-letter
queue yet.

## Notifications

- **Triggers (12a):** `task.assigned` -> `TASK_ASSIGNED` to the assignee; `lead.converted` ->
  `LEAD_CONVERTED` to the lead owner; `deal.stage_changed` -> `DEAL_STAGE_CHANGED` / `DEAL_WON` /
  `DEAL_LOST` to the deal's **current** owner. Nobody is notified of their own action.
  `LEAD_ASSIGNED` needs a `lead.assigned` event that does not exist; `TASK_DUE_SOON` / `TASK_OVERDUE`
  are 12b.
- **Wording is generic** ("A task was assigned to you") and the `payload` carries ids only
  (`{taskId}`), matching the event contract (ids, no personal data). A client links through the ids.
- **Owner of a deal event:** the event has no owner (ids only), so `DealsService.findOwnerId` reads it
  inside the event's tenant. If the deal is gone, nobody is notified.
- **Idempotency:** `Notification.dedupeKey` (migration `add_notification_dedupe_key`) is unique with
  `organizationId`. The insert is `createMany({ skipDuplicates })` (`ON CONFLICT DO NOTHING`): any number
  of workers or retries produce one row. The key names the business fact
  (`task.assigned-<taskId>-<assignedAt ms>`) and is also used as the BullMQ job id, a cheap first line of
  defence that only holds while the job is still stored. NULL keys never clash (PostgreSQL).
- **Unknown recipient** (no such user, or a user of another organization): the composite FK rejects
  the insert, the job **completes as skipped** with a warning. Retrying cannot fix it. A deactivated
  user is still a valid recipient (the row simply sits unread).
- **API** (`/api/v1/notifications`): list (offset pages, newest first, `unread=true`), `unread-count`,
  `POST :id/read`, `POST read-all`. No `@Permissions`: every query is keyed on the caller's own
  `userId`, so an ADMIN cannot read another user's inbox. Another user's or organization's id is 404.
  Mark-read is idempotent and keeps the first `readAt`. Offset pagination, because an inbox is small
  and bounded per user (cursor pagination is reserved for activities and audit logs).

## Delivery guarantees (read this before relying on notifications)

| Step                           | Guarantee                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Business write -> domain event | In-process, emitted **after** the commit (`publishDomainEvent`). **Not atomic** with the write. |
| Event -> `queue.add`           | Best effort. Redis down / slow (bounded by 2 s): logged, swallowed, request unaffected.         |
| Queue -> worker -> table       | At-least-once with retries; the unique `dedupeKey` makes the result exactly-once.               |

So a notification **can be lost** if the process dies between the commit and the `add`, or if Redis is
unreachable at that moment. Nothing re-sends it. **There is no guaranteed delivery.** This is the known
gap that ADR 0008/0009/0010 named. Closing it needs a transactional outbox (an `OutboxEvent` row written
in the business transaction plus a relay job); that touches Leads, Deals and Tasks and is **deferred to
its own decision**. Until then, anything that must not be lost cannot depend on this path.

## Shutdown and outages

- Workers close gracefully, but `WORKER_CLOSE_TIMEOUT_MS` (10 s) bounds the wait and then closes by force: with
  Redis down a graceful close never returns. A job cut off that way is re-delivered (stalled-job recovery).
- Queues have an `error` listener (otherwise a connection error would throw inside the client).
- `/health/ready` pings Redis through the queue connection (`RedisHealthIndicator`), bounded to 2 s; it replaced
  the TCP probe (`TcpHealthIndicator` was deleted).

## Testing

- **Unit:** job factory (recipients, keys, no self-notification), dispatcher (swallows enqueue failure, logs
  no content), listener, service, processor, workers service (tenant, unrecoverable, forced close),
  queue service (timeout, error listener), env schema, `withTimeout`.
- **E2E uses the real compose Redis**, never a mock: retries, backoff, final failure and concurrency are
  exactly what a mock would not prove. `createTestApp({ queue: { workers } })` connects the app to
  `TEST_REDIS_PORT` under a private `salesflow-test-<random>` prefix; `purgeTestQueues` removes **only
  that prefix's** keys (`obliterate`), and nothing ever flushes Redis. The default e2e wiring still
  points Redis at a dead port with workers off, and one suite proves the API keeps working then.
- Local gotcha: port 6379 on this machine belongs to another project's Redis. This project's Redis is
  published on `REDIS_HOST_PORT` (6380 in the local `.env`) by the dev override.

## Known limits

- No outbox (above). No dead-letter queue. Notification text is not localized (English only, per project rule).
- Notification retention and the refresh-token clean-up arrived in 12b; scheduling uses BullMQ job schedulers, not `@nestjs/schedule` (see [ADR 0012](0012-scheduled-jobs.md)).
- Redis shares one `QUEUE_PREFIX` per environment; two environments on one Redis must use different prefixes.
