# ADR 0010: Tasks and follow-ups

Status: accepted (Phase 11, one step, two commits: tasks CRUD / status / links / overdue, then the
contact and company delete blockers).

## What is built now, what waits for Phase 12 (BullMQ)

| Now                                                                            | Phase 12                                                    |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Task CRUD, assignment, status workflow, four optional links                    | Reminder job (sends at `reminderAt`, sets `reminderSentAt`) |
| `reminderAt` accepted, validated, stored; changing it re-arms `reminderSentAt` | Overdue scheduler (cron)                                    |
| Overdue computed on read (`?overdue` filter + `isOverdue` field)               | `TASK_DUE_SOON` / `TASK_OVERDUE` notifications              |
| `task.assigned` domain event (in-process, after commit)                        | Consumers of `task.assigned` (notification, activity)       |
| Contact / company delete blockers                                              |                                                             |

No migration: the `Task` table already had every column, composite FK and index this needs.

## Visibility follows the assignee

Tasks have no `ownerId`; the **assignee is the owner**. `applyVisibility(where, scope, 'assigneeId')`
is ANDed into every read and write (ADR 0005/0007). Consequences, all intended:

- A rep sees only tasks assigned to them; a manager their own plus their direct reports'; an admin all.
- **A rep who loses a task (an admin or manager reassigns it) can no longer see it**: it answers 404,
  even though they created it. `createdById` is still recorded and returned, but grants nothing.
- Assignment reuses `ownerForCreate` / `ownerForTransfer`: the assignee defaults to the caller; a
  rep may only name themselves (`400 INVALID_OWNER`), a manager their team, an admin anyone in the
  organization. One `INVALID_OWNER` for every reason, so it reveals nothing about other users.
- `task.assigned` is published only when a task is **created for someone other than its creator** or
  its **assignee changes**, never on an ordinary edit or when the same assignee is sent again. Payload:
  ids and `organizationId` only.

## Status workflow

`POST /tasks/:id/status {status}` through the shared `applyStatusTransition` (read with visibility,
map check, one compare-and-set on the status read):

`OPEN -> IN_PROGRESS | COMPLETED | CANCELLED`, `IN_PROGRESS -> OPEN | COMPLETED | CANCELLED`,
`COMPLETED -> OPEN`, `CANCELLED -> OPEN`. Same status is `409 INVALID_TASK_TRANSITION` (not
idempotent, like leads); a lost race is `409 TASK_STATUS_CHANGED`. COMPLETED sets `completedAt`; every
other status clears it, so a **reopen clears `completedAt`**.

A **closed task (COMPLETED / CANCELLED) is read-only** until reopened: edits carry
`status IN (OPEN, IN_PROGRESS)` in the same statement as the write; a miss on a visible closed task
re-reads with visibility and answers `409 TASK_CLOSED`, anything else is the single 404 (a hidden
closed task is never revealed). `status` is not editable through PATCH (400).

## Time handling

- `dueDate` and `reminderAt` are **full instants**, not date-only values. Input must be ISO 8601
  **with a timezone** (`Z` or `+hh:mm`); a bare date or a date-time without an offset is a 400
  (`IsInstant`: a server-zone reading would be ambiguous). Stored as UTC, returned as UTC ISO strings.
  A frontend renders "due today" in the user's own zone.
- **One `now` per request**: each service method reads the clock once and uses that value for the
  `?overdue` filter, the `isOverdue` field and the reminder checks, so they cannot disagree.
- **Overdue** is computed, never stored, with one definition (`overdueWhere` / `isOverdue` in
  `tasks.constants.ts`): status OPEN or IN_PROGRESS and `dueDate < now`, strictly. A task due exactly
  now is not overdue; a COMPLETED / CANCELLED task never is; no due date is never overdue.
  `overdue=false` is written out as the exact complement (a plain NOT would drop NULL due dates).
- A **past `dueDate` is allowed** on create (backlog entries). A **past `reminderAt` is rejected**
  (`400 INVALID_REMINDER`) when it is being set or changed: a reminder that can never fire at its time
  is a client mistake, and the Phase 12 job would otherwise fire it at once. `reminderAt` must not be
  after `dueDate` (checked against the merged values, so moving only the due date before the stored
  reminder is refused too). An untouched stored reminder is never re-judged against the clock, so a
  task can still be edited after its reminder time.
- Changing `dueDate` or `reminderAt` to a different instant sets `reminderSentAt = null`, so the
  Phase 12 job (which skips tasks with it set) fires again for the new time. Sending the same instant
  (in any offset) does not.

## Links

`leadId`, `dealId`, `contactId`, `companyId`: any combination, nullable FKs (no polymorphic string).
Each must be a record the caller can see (`INVALID_LEAD` / `INVALID_DEAL` / `INVALID_CONTACT` /
`INVALID_COMPANY`: one 400 per record kind for missing, deleted, foreign-organization and not-visible).

- **Locks only when a contact or company link CHANGES** (the 7b rule). A new contact / company link
  runs in one transaction holding **shared** advisory locks (order company, contact; the global order
  org, lead, pipeline, company, contact is unchanged) with the check inside it. Changing status,
  priority, title, dates or assignee, repeating an unchanged link, or unlinking takes no lock and opens
  no transaction (unit tests assert it; an e2e test holds both exclusive locks and runs all of these).
- **Lead and deal links take no lock**: nothing blocks deleting a lead or a deal, so there is no
  check-then-write race to protect.
- **Open tasks do not block deleting a lead or a deal.** A task pointing at a deleted lead / deal
  keeps the id and reads fine (the response carries ids only, never nested records, and nothing joins
  the linked row), so it never causes a 500. Same for a deleted contact or company (their closed tasks).
- **Reopening a task whose linked contact or company was deleted is allowed**; the link is not
  re-validated (it is unchanged), and the task simply points at a deleted row.

## Delete

Tasks are **hard-deleted** (not on the soft-delete list). **COMPLETED / CANCELLED tasks can be deleted
by an ADMIN only**, so a rep or manager cannot erase their own history: for everyone else
`status IN (OPEN, IN_PROGRESS)` is part of the delete statement itself; a miss on a task they can see is
`403 TASK_DELETE_RESTRICTED`, a task they cannot see is 404 (a rep deleting a colleague's task, open or
closed, gets 404). Each delete writes a structured log (`task.deleted`: `organizationId`, `taskId`,
`actorId`; no title, no personal data).

**TODO Phase 13:** record task deletes (and reassignments) in the audit log; until then the log line
is the only trace.

## Contact and company delete blockers (closes the Phase 10/11 TODO)

`ContactsRepository.softDeleteIfUnused` / `CompaniesRepository.softDeleteIfUnused` also count
**OPEN and IN_PROGRESS tasks** linked to the record (`CONTACT_HAS_OPEN_TASKS`,
`COMPANY_HAS_OPEN_TASKS`, 409):

- Order of answers: **visibility 404 first**, then the existing blockers (company: contacts, then
  deals; contact: deals), then **tasks**.
- The count is **not visibility-scoped** (another user's open task blocks too); the message carries no
  counts or owners.
- The count runs **after the exclusive lock is taken**. Task writes take the same lock in shared mode,
  so a link that runs first is counted (409), and one that runs after sees the record deleted (400).
  Mutation-checked: removing the task-side locks, or the delete-side lock, fails the deterministic lock
  tests and all four 20-iteration race tests.
- COMPLETED / CANCELLED tasks do not block, and stay readable afterwards.
- A task that is completed or reopened concurrently with a delete may make the delete answer from a
  slightly stale count: a harmless 409 (retry), never a lost record.

## Known limits

- `sortBy=dueDate` puts tasks without a due date last (asc) or first (desc) (Postgres default).
- The event is in-process and lost if the process dies between commit and emit (Phase 12 closes this,
  same note as ADR 0008/0009).
- Duplicated test helper: `holdLock` exists in older e2e specs; new specs use
  `test/support/advisory-locks.ts`. Moving the old ones is a follow-up.
