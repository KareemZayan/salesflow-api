# ADR 0012: Scheduled jobs (reminders, overdue notices, clean-up)

Status: accepted (Phase 12b). Builds on [ADR 0011](0011-queue-and-notifications.md); everything there
(queue service, tenant context for jobs, job options, dedupe keys) is reused unchanged.

## Scheduling: BullMQ job schedulers, not `@nestjs/schedule`

Schedules are BullMQ **job schedulers** (`Queue.upsertJobScheduler`). This **replaces the earlier plan
to use `@nestjs/schedule`** (ADR 0011 / PROJECT_STATUS said it would arrive in 12b); no new package is
installed.

- A cron decorator fires once **per API instance**; three instances would run every sweep three times.
  A scheduler lives in Redis and fires **once for the whole cluster**.
- `upsertJobScheduler` is idempotent by id: every instance may call it on every boot and there is still
  one schedule per sweep. Changing an interval in code replaces the stored one on the next deploy.
- Only instances with `QUEUE_WORKERS_ENABLED=true` register them. If Redis is down at boot the error is
  logged and the API starts anyway; the schedules appear on the next start and the due work waits in
  the database (nothing is lost).

## Two levels: a cheap sweep, then tenant jobs

```
scheduler -> SWEEPS queue (cross-tenant, tenantScoped=false)
               "which active organizations have work?"   (one grouped, index-served query)
               -> one job per such organization on its own queue, jobId = <sweep>-<org>-<time bucket>
                    -> tenant job (organizationId in the payload, runs in that tenant's context)
```

| Sweep                    | Cadence         | "Who has work?"                                               | Per-organization job               |
| ------------------------ | --------------- | ------------------------------------------------------------- | ---------------------------------- |
| `task-reminders`         | every 1 min     | open tasks with `reminderAt <= now`, `reminderSentAt IS NULL` | `TASK_DUE_SOON` notifications      |
| `task-overdue`           | every 15 min    | open tasks with `dueDate < now`, `overdueNotifiedAt IS NULL`  | `TASK_OVERDUE` notifications       |
| `refresh-token-cleanup`  | daily 03:15 UTC | every active organization                                     | delete long-expired refresh tokens |
| `notification-retention` | daily 03:30 UTC | every active organization                                     | delete old notifications           |

**Cost decision (numbers).** Reminders are the time-sensitive part, so they run every minute; a
reminder is therefore **at most one tick (about one minute) late, which is accepted**. Overdue is a
status report, not a deadline: every 15 minutes (15x fewer queries). Both ask the database for the
organizations that have pending work **before** fanning out, using the partial indexes
`Task_reminder_pending_idx` and `Task_overdue_pending_idx` (rows leave the index the moment their marker
is set), so an idle system costs two cheap queries per tick and **enqueues zero jobs**. The daily
housekeeping skips the "who has work?" scan on purpose: one job per active organization per day costs
less than scanning the notification and token tables to find out.

**Separate queues** per kind of tenant work (`task-reminders`, `task-overdue`, `refresh-token-cleanup`,
`notification-retention`): a slow clean-up can never sit in front of a reminder, and each has its own
concurrency and failure history. `QUEUE_NAMES` / `DEFAULT_JOB_OPTIONS` / `JobQueueService` are the 12a
ones; the only infrastructure additions are `JobQueueService.schedule` and handlers that declare
`tenantScoped: false` (only the sweeps).

## Overlap, failure and duplicates

- **Time-bucketed job id.** The per-organization `jobId` is `<sweep>-<organizationId>-<bucket>`, the
  bucket being `floor(now / period)`. Overlapping or repeated sweeps in one period create **one** job
  per organization. A new period creates a new job, which is how a big backlog continues.
- **Sweep fails midway.** Enqueues are settled one by one: the others still go out, the failures are
  counted and the sweep then throws (sweeps have `attempts: 1`; the next tick is the retry). Jobs already
  enqueued keep running; the next sweep finds the organizations that still match and adds only those.
  Nothing is duplicated, because the markers and the dedupe keys make every job idempotent.
- **Inactive organizations** are skipped by every sweep query (tested). A job enqueued just before an
  organization was deactivated still runs once; that window is accepted.
- **Cap per job: 500 tasks** (`TASK_ALERT_BATCH_LIMIT`). One big organization cannot hog a worker: it
  handles 500, and the next sweep continues (1,200 due tasks = 3 sweeps, tested). Clean-ups are capped
  at 50 batches of 1,000 per run; the next daily run continues.

## Reminders and overdue notices

Order per task: **enqueue the notification, then set the marker.** A crash in between repeats the
enqueue next run, which the `dedupeKey` turns into a no-op; the reverse order could lose a notification.
An enqueue failure (`dispatchStrict`, which does not swallow errors) throws before the marker, so the job
retries and the task stays due. The keys are `task.reminder-<taskId>-<reminderAt ms>` and
`task.overdue-<taskId>-<dueDate ms>`: moving the date is a new fact (new key), a retry is a duplicate.

**Conditional marker.** The marker update matches `reminderSentAt IS NULL` **and the same `reminderAt`
that was read** (overdue: `overdueNotifiedAt IS NULL` and the same `dueDate`). A date changed between
the read and the marker matches nothing and is never marked as done; it fires on its own at its new
time. The narrow window can leave one notification for the _old_ instant (it was already enqueued); its
key differs from the new one, so the new reminder is unaffected. Mutation-checked: removing the
`reminderAt` condition makes the test fail.

**`Task.overdueNotifiedAt`** (migration `add_task_overdue_notified_at`, plus the two partial indexes).
`TasksService.update` clears it **in the same UPDATE statement** that changes `dueDate` (and clears
`reminderSentAt` when the reminder or the due date moves). **Reopen decision:** reopening a COMPLETED or
CANCELLED task does **not** clear it. A reopened task is not notified again for the same `dueDate`;
giving it a new `dueDate` re-arms the notice. Rationale: the person just reopened it and knows it is late;
a second "overdue" for the same deadline is noise.

## Clean-up jobs

- **Refresh tokens.** Deleted only when `expiresAt` is more than **7 days** in the past
  (`REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_DAYS`), so nothing inside the grace window is touched, and
  **never while the family still has a live token** (not revoked, not expired): that family is an open
  session. A family with no live token can never get one back (a token is only issued by rotating a live
  one), so deciding and deleting need no transaction. Batched by id cursor (1,000 per statement), so
  rows that are kept are not read again.
- **Notifications** (`NOTIFICATION_RETENTION_DAYS`): read ones after **90 days**, unread ones after
  **180 days**, counted from `createdAt`. New index `(organizationId, createdAt)` serves the job.
  **This is a permanent delete** (no archive, no soft delete). The job logs only the **number** of rows
  deleted, never their title, body or payload.
- Both numbers are constants next to the code that uses them; change them there.

## Known gaps (unchanged by this phase)

- **A lost `task.assigned` event is still a known gap.** The event -> enqueue step remains best effort
  after the commit (ADR 0011). The sweeps do **not** repair it; they only cover the time-based alerts,
  whose source of truth is the task row itself and which therefore self-heal. The **outbox stays a
  separate architectural decision** (touches Leads, Deals and Tasks).
- `LEAD_ASSIGNED` and Bull Board / failed-job handling / the README section arrived in 12c (see ADR 0011).
