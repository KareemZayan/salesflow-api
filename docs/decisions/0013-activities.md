# ADR 0013: Activities (the business timeline)

Status: accepted (Phase 13a). Builds on [ADR 0011](0011-queue-and-notifications.md) and
[ADR 0012](0012-scheduled-jobs.md): the queue service, the tenant context for jobs, the job options and
the dedupe-key idea are reused unchanged. **Audit logs are a separate feature (13b)**: an audit trail is
a compliance record for admins, a timeline is a sales tool for everybody who can see a record.

## What it is

A timeline per **lead, deal, contact and company**, newest first, made of

- **system entries**, written from domain events: `lead.converted`, `lead.status_changed`,
  `lead.assigned`, `deal.stage_changed`;
- **manual entries** (`CALL`, `EMAIL`, `MEETING`, `NOTE`) logged by users.

`lead.status_changed` is new (published by `LeadsService.changeStatus` after the compare-and-set
matched, never for a rejected or lost transition). It **closes the `LeadStatusHistory` TODO from 8b**
without a second table. Task events are not recorded: `Activity` has no task link.

## System entries: through the queue, best effort

```
domain event (after the business commit)
  -> ActivitiesListener -> activity-job.factory (pure: wording, metadata, keys)
     -> one job per TARGET record on the `activities` queue (JobQueueService, enqueueBestEffort)
        -> ActivitiesProcessor (tenant from the payload) -> ActivitiesService.createFromJob
           -> INSERT ... ON CONFLICT DO NOTHING on (organizationId, dedupeKey)
```

- **A lost event means a missing timeline entry, and that is acceptable for activities** (a note on a
  sales timeline, regenerable by nobody but also not a compliance record). The audit trail is different
  and must not be built on this guarantee: that is the outbox / in-transaction question to settle
  before 13b. Event -> enqueue is best effort (as in ADR 0011); queue -> table is at-least-once +
  idempotent.
- **dedupeKey = event + subject + instant + target**, e.g.
  `lead.converted-<leadId>-<ms>-contact-<contactId>`. One event gives one entry **per target**
  (lead, contact, company, deal), and a redelivery of any of those jobs inserts nothing. The key doubles
  as the BullMQ job id; it contains `.` and `-` only (BullMQ rejects `:`).
- **The processor never uses an unscoped client.** It runs in the tenant named by the payload and
  writes through the tenant client. The composite foreign keys `(<link>, organizationId)` reject a
  payload that names a record of another organization (`unknownTarget`, completed as skipped, logged by
  key only). Tested directly and through the real queue.
- **Shared best-effort enqueue.** `enqueueBestEffort` (`infrastructure/queue`) is the one
  swallow-and-log wrapper for producers that run after a commit. `NotificationDispatcher` was changed
  to use it (its spec is untouched); activities use it directly. There is no second dispatcher class.

## Privacy: deal details on other timelines

A deal's stage move is recorded on the deal **and on its contact and company**. A rep may see a contact
without seeing the deal that is linked to it (visibility follows the owner), so deal data must not leak
through the contact timeline.

Decision: **store only ids, redact on read, do not filter.**

- A stored subject is static (`Deal stage changed`); it never contains a title, name or amount, and
  neither does metadata. What is stored about a deal is ids and enums only (`dealId`, `fromStageId`,
  `toStageId`, `status`), **all under one metadata key, `deal`**.
- On the timeline of a lead, contact or company, the response keeps `metadata.deal` only for deals the
  caller may see (**one** `findMany` per page over at most `limit` ids, `DealsService.visibleIds`,
  which uses the same visibility rule as `GET /deals/:id`). For the others the `deal` key is removed:
  no deal id, no stages, no status, no amount, no title. A **deal timeline** needs no check: its parent
  check already proved the caller sees that deal.
- Why not filter the entries out: visibility depends on the deal's owner, which is not a column of the
  activity, so a filter needs a join (or an `IN` over every deal the user can see) inside a keyset
  query, and a page that loses rows after the query breaks the cursor contract. Redaction costs one
  small query and keeps pages stable.
- Accepted residual leak: the viewer can see that "a deal stage changed" for their contact, without
  which deal. The contact, company and lead ids in metadata are bare identifiers of records the entry
  is about; reading them still goes through each record's own visibility check.

## Visibility and permissions

- **Every timeline endpoint checks the parent first**, with the owning module's existing visible-or-404
  read (`LeadsService.get`, `DealsService.get`, `ContactsService.get`, `CompaniesService.get`), before
  any activity query. A hidden, missing, soft-deleted or foreign parent is the same 404 and no activity
  query runs (unit-tested for all four kinds). A malformed cursor is judged after the parent.
- Permissions are all-of: `activities:read` / `activities:create` **and** `<parent>:read`. There is no
  `activities:delete`: deleting is part of logging.
- **Manual notes are visible to everyone who can see the parent.** Free text can hold sensitive
  content (names, prices, health or legal remarks). It is trimmed, limited (subject 200, body 5000),
  documented in Swagger, **never logged** (the service logs nothing; the validation pipe does not echo
  values; queue logs carry the dedupe key only), and never edited (no edit endpoint). A client cannot
  send `actorId` or `occurredAt` (whitelist, `forbidNonWhitelisted`).

## Deleting

| Case                                                               | Answer                           |
| ------------------------------------------------------------------ | -------------------------------- |
| Entry missing / other organization                                 | 404                              |
| Caller is not admin and cannot see the parent (author included)    | 404 (never 403: no confirmation) |
| System entry the caller can see (any role, admin included)         | **409 `ACTIVITY_IMMUTABLE`**     |
| Manual entry of someone else, caller sees the parent, not admin    | 403 `ACTIVITY_DELETE_RESTRICTED` |
| Manual entry, author while they still see the parent, or any admin | 204                              |

- **System entries answer 409, not 404.** By then the caller has proved they can see the entry (it is on
  their timeline), so 409 reveals nothing and tells the client precisely why. For someone who cannot
  see it, the parent check answers 404 first, so a hidden system entry is never confirmed.
- The 404 for a hidden parent says "Activity not found", never "Lead not found".
- The delete statement itself carries the guard (`type IN manual types` and, for a non-admin,
  `actorId = caller`); a lost race is a 404.
- An admin skips the parent check: an admin sees the whole organization, so it could only fail for a
  soft-deleted parent.

## Cursor pagination

- **Order `(occurredAt desc, id desc)`.** `occurredAt` (not `createdAt`) because the indexes that
  already exist are `(organizationId, <link>, occurredAt DESC, id)` and because a system entry's
  `occurredAt` is the event time while `createdAt` is when the worker wrote it; a delayed worker must
  not reorder history. Manual entries have `occurredAt = now` (the client cannot set it). The index
  serves the `occurredAt` ordering; the `id desc` tie-break is a cheap incremental sort on ties.
- The cursor is opaque (base64url JSON of organization, instant, id), **tied to the organization**,
  strictly validated (UUID id, ISO instant, same organization). Anything else, another organization's
  cursor included, is `400 INVALID_CURSOR`. It is not signed: editing it to another position of the same
  organization only moves the window over rows the caller may already read. The helper
  (`common/utils/keyset-cursor.util.ts`) is generic and is meant to be reused by the audit log.
- `limit` is `CursorQueryDto`: default 20, **max 100**, otherwise 400.

## Database

Migration `add_activity_dedupe_key_and_link_check`:

- `Activity.dedupeKey` (nullable) + unique `(organizationId, dedupeKey)`, the same shape as
  `Notification` (NULLs are distinct, so manual entries never clash).
- `CHECK "Activity_has_link_check"`: at least one of `leadId`, `dealId`, `contactId`, `companyId` is set.
  Prisma cannot express it, so it is raw SQL in the migration (a later `migrate dev` stays empty). The
  application writes exactly one link; the constraint is the backstop for any other writer.

## Retention (deferred) and indexes

- **Activity retention is deferred.** Nothing deletes timeline entries; the table is append-heavy but
  each read is a bounded index range. A retention policy (age, per organization, batch delete as in 12b)
  is a product decision that has not been made.
- The cursor indexes **exist already** (`Activity` in the init migration: one `(organizationId, <link>,
occurredAt DESC, id)` index per link), so no index was added.
