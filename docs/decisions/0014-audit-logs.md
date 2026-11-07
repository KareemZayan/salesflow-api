# ADR 0014: Audit logs (who changed what, and when)

Status: accepted (Phase 13b). Builds on [ADR 0002](0002-tenant-scoping.md) (tenant scoping),
[ADR 0012](0012-scheduled-jobs.md) (the retention job) and [ADR 0013](0013-activities.md)
(the keyset cursor). An audit trail is a compliance record for administrators; the activity timeline
(ADR 0013) is a sales tool for everybody who can see a record. They are separate on purpose.

## The decision: the audit row is written IN THE TRANSACTION of the audited change

```
service.<action>(...)
  -> repository.withOrgLock / inLocks / $transaction (tx)
       1. the business write(s)
       2. AuditService.record(tx, { event, entityId, before?, after? })     <- same tx
  -> commit: both exist, or (rollback) neither
```

**Fail-closed.** If the audit insert fails, the business change fails and is rolled back. If the
business change fails, there is no audit row. This is tested both ways for every audited action, with
the audit insert failure injected.

- **Not through the queue.** A queue is best effort (ADR 0011): an event lost between commit and
  enqueue, or a job that exhausts its retries, would leave a change with no audit row. For an audit
  trail that is not acceptable. This **replaces** the CLAUDE.md line "written asynchronously via
  queue" (edited with the owner's approval).
- **No outbox for audit.** A same-transaction insert already has the guarantee an outbox would add.
- **The generic outbox is NOT being built now.** Notifications (ADR 0011) and timeline entries
  (ADR 0013) stay best effort, with the documented gap: a domain event lost between the business
  commit and the enqueue loses a notification or a timeline entry. The decision on an outbox for them
  is open and is to be revisited **before production**.

### Consequences, stated plainly

- **Login depends on the audit table.** A successful login writes its audit row in the same
  transaction as the session and `lastLoginAt`, _before_ any token is returned. If the audit insert
  fails, nobody can sign in. That follows directly from fail-closed.
- One extra INSERT inside transactions that were already open; actions that had no transaction
  (organization update, task delete / reassign, deal amount edit, login, logout) now open one.
- Concurrent edits of the _same_ entity at the same instant can each record the value they read as
  "before" (no row lock; the deal and task `before` is read inside the transaction, right before the
  write). The stored data is always the last write; only the trail of two simultaneous edits of one
  row can be imprecise. Organization updates take the organization lock, so theirs cannot.
- `createdAt` is the transaction's start time (`CURRENT_TIMESTAMP`), which orders rows for the
  cursor; a very long transaction can therefore commit a row dated slightly before one already read.

## Mechanism

`AuditService.record(tx, entry, subject?)` (`modules/audit-logs`):

- **Actor, organization, IP, user agent and request id come from the request context**
  (`nestjs-cls`), never from the caller or the request body. IP, user agent and request id are read
  lazily from the HTTP request stored in the CLS context (`RequestMetadataService`).
- **`@Audit()` is dropped.** An interceptor runs after the handler, i.e. after the commit, so it
  cannot write in the business transaction. Request metadata needs no decorator either.
- **`subject`** exists only for login and logout, which run without a tenant context: the caller
  passes the `actorId` and `organizationId` of the _user it loaded from the database_. If a tenant
  context exists and disagrees, `record` throws: a row is never written for another organization.
- **`event` must be in `AUDIT_EVENTS`** (`audit-events.ts`, a union type; each event fixes its
  coarse `action` and `entityType`). `record` rejects anything else at runtime. The column is a plain
  `TEXT`, so a new event is one line of code and **no migration**.
- **`tx` is typed `Prisma.TransactionClient | TenantTransactionClient`.** The type alone cannot stop
  someone passing a `PrismaService` (a client has every member of its own transaction client), so
  `record` also refuses anything that has `$connect`: Prisma strips `$connect`, `$disconnect`, `$on`
  and `$extends` from the client handed to a transaction callback. Tested against a real database.
- A call that changed no audited field (same email PATCHed again) writes nothing.

## What is audited

| Event                                            | Where         | Stored (changed fields only)                             |
| ------------------------------------------------ | ------------- | -------------------------------------------------------- |
| `user.created`                                   | Users         | email, names, role, manager, isActive                    |
| `user.updated`                                   | Users         | email, first/last name, manager (old and new)            |
| `user.deactivated` / `user.reactivated`          | Users         | `isActive`                                               |
| `user.role_changed`                              | Users         | `roleId`                                                 |
| `user.password_reset`                            | Users         | the event only                                           |
| `role.created` / `role.updated` / `role.deleted` | Roles         | name, permission keys (deleted: what it was)             |
| `role.permissions_changed`                       | Roles         | permission keys                                          |
| `organization.updated`                           | Organizations | name, default currency                                   |
| `auth.login` / `auth.logout`                     | Auth          | the event only (logout only when a session really ended) |
| `auth.password_changed`                          | Auth          | the event only                                           |
| `deal.money_changed`                             | Deals         | `amount` as a string and `currency`, only what changed   |
| `task.reassigned` / `task.deleted`               | Tasks         | `assigneeId` only                                        |

**Not audited, on purpose.** Deal stage moves (`DealStageHistory`), lead status / assignment /
conversion and deal stage events (Activities, ADR 0013): they already have their record, and a second
copy would be a second source of truth. Refresh-token rotation (operation, not a security event).
The `org:create` CLI (no request context). Reading the audit log (it would write a row per page view).
Deal / task _creation_ (not in the agreed list).

**Failed logins are not audited.** A structured log line only: an attacker can generate failed
logins at will, so a row per attempt is a flood risk (and the throttler already limits them).
TODO: a rate-limited aggregate (for example per account and hour) if the business needs the trail.

## before / after: changed fields only, allowlisted, never secrets

- One allowlist per entity type (`audit-fields.ts`). A column added later is **not** audited until it
  is listed on purpose. Unlisted fields are dropped.
- Never listed: `passwordHash`, tokens, secrets, notes, descriptions, titles (long free text). A
  second net refuses (throws, so the change rolls back) any key matching
  `password|token|secret|hash|credential|authorization|cookie`, any string over 255 characters and
  any list over 200 entries.
- A password reset or change stores the event only.
- **The user allowlist stores old and new email. That is personal data, kept for the retention
  period** (and administrators can read it). IP address and user agent are personal data too.

## Append-only at the database level

Migration `add_audit_log_event_request_id_and_immutability` adds a `BEFORE UPDATE OR DELETE`
trigger:

- `UPDATE`: always rejected.
- `DELETE`: rejected unless the transaction set `app.audit_retention` to `on` **with `SET LOCAL`**
  (`set_config(..., true)`). Only the retention job does, inside its own transaction; the value
  vanishes when that transaction ends, so no pooled connection keeps it (tested, including after a
  rollback). Plain `SET` is never used.
- `TRUNCATE` is **not** blocked: the test reset helper needs it. Production code never issues one
  (a unit test scans `src/`, `prisma/seed/` and `docker/`). The only `TRUNCATE` statements live under
  `test/`.

**This is application-level defence in depth, not protection against a database administrator.**
A superuser can drop the trigger or set the flag. Hash-chaining the rows (each row carrying the hash
of the previous one) would make tampering detectable even then; it is a documented future upgrade
only, not built.

**A data migration that backfills or rewrites audit rows must disable the trigger inside the
migration** (`ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only"`) and enable it again
before the migration ends, in the same migration file.

Rows survive the deletion of the audited entity: `entityId` has no foreign key (a deleted role or task
keeps its trail). `actorId` is a composite FK to the user; users are deactivated, never deleted.

## Read API

`GET /api/v1/audit-logs`, permission `audit-logs:read` (already in the permission catalogue; the seed
gives it to ADMIN only, because only ADMIN is synced with the whole catalogue).

- **Cursor pagination** on `(createdAt desc, id desc)` through the shared keyset helper (ADR 0013);
  the cursor is bound to the organization. **No total count** (the table is large and append-heavy).
- Filters: `actorId`, `entityType`, `entityId`, `action`, `event`, `from`, `to`.
- Tenant isolation comes from the tenant-scoped client; another organization's rows and cursors are
  invisible.
- **Administrators see `ipAddress` and `userAgent` in this response. No other endpoint exposes
  them** (tested).
- Reading the audit log is not itself audited.
- Indexes: `(organizationId, createdAt desc)` (new: list, date range, retention),
  `(organizationId, entityType, entityId, createdAt desc)` and
  `(organizationId, actorId, createdAt desc)` (existing).

## Retention

`AUDIT_RETENTION_DAYS = 730` (`audit-logs.constants.ts`), a conservative default. **How long an audit
trail must be kept is a legal / contractual decision for the project owner to confirm before
production.** The daily job (`audit-retention`, 03:45 UTC, one job per active organization like
ADR 0012) **permanently deletes** rows older than that, in batches of 1,000 (at most 50 per run), all
inside the one transaction that sets the retention flag. Only the number of deleted rows is logged.
The job is idempotent; the next run continues.

## Alternatives considered

- Queue the audit write (best effort): rejected, see above.
- Outbox table drained by a worker: not for audit (same-transaction is stronger and simpler); the
  generic outbox for notifications / timeline is deferred.
- `@Audit()` interceptor: cannot run in the business transaction.
- Database triggers that audit every table automatically: no access to the application actor,
  request id or the allowlist, and they would audit columns nobody reviewed.
- A column per event type, or an `AuditAction` enum value per event: a migration per new event.
