# ADR 0008 — Leads (Phase 8)

Status: accepted (8a CRUD + scoring and 8b status workflow implemented)

Leads follow the Companies/Contacts template (ADR 0007): visibility ANDed into the same `where` as
the write, `resolveAssignableOwner` for owners, one `404` for hidden/missing/foreign/deleted. This
ADR records only what is specific to leads.

## Null-owner rule: every lead has an owner

`Lead.ownerId` is `NOT NULL` (composite FK to `User`, `onDelete: Restrict`) and stays that way.
`ownerId` defaults to the caller on create; naming someone else goes through
`ownerForCreate` / `ownerForTransfer`. Sending `ownerId: null` is a `400` on PATCH and means "the
caller" on create (omitted and `null` are the same).

Why: an unassigned pool needs a migration and new visibility rules (who sees ownerless leads, who may
claim them), and nothing asks for it yet.

**Upgrade path:** make `ownerId` nullable, add a "claim" operation, and make ownerless leads visible
to managers and admins (a third branch in `applyVisibility`). **This closes the question left open in
ADR 0005/6c** ("ownerless records are admin-only until Phase 8 decides"): there are no ownerless
records, so `applyVisibility` needs no ownerless rule.

## Scoring: Strategy, server-computed, stored

`LeadScoringStrategy.score(input)` is pure and synchronous; `RuleBasedLeadScoringStrategy` is bound
to the `LEAD_SCORING_STRATEGY` token in `LeadsModule` (swapping it is a one-line change). The score
is stored in `Lead.score` (0-100) so lists can sort and filter on it. Clients cannot send it
(`forbidNonWhitelisted` answers 400).

**Rules (adjustable defaults, not business law)** — all in one object, `LEAD_SCORE_WEIGHTS`
(`scoring/lead-scoring.constants.ts`):

| Input               | Points                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| source              | REFERRAL 40, PARTNER 35, WEBSITE 30, EVENT 25, EMAIL_CAMPAIGN 20, SOCIAL_MEDIA 15, COLD_CALL 10, OTHER 0 |
| email present       | +20                                                                                                      |
| phone present       | +15                                                                                                      |
| companyName present | +10                                                                                                      |

Every `LeadSource` has an explicit weight (`Record<LeadSource, number>`: a new enum value fails
typecheck until weighted). The result is rounded and clamped to 0-100, so re-weighting can never
leave the range (tested at both boundaries with inflated and negative weights). Blank or
whitespace-only email/phone/companyName earn nothing: the DTOs store them as `NULL`, and the strategy
also treats blank as missing for rows written some other way.

Existing leads are NOT rescored when the weights change; a change to the weights needs a backfill.

### One list of scoring fields

`SCORING_FIELDS = ['source','email','phone','companyName']` (`scoring/lead-scoring.strategy.ts`) is
the only definition. `LeadScoringInput` is derived from it, the repository's recompute `select` is
built from it, and the service uses it to decide whether an update needs a recompute. A unit test
proves every listed field changes the score, so the list and the rules cannot drift.

### Recompute and the lead lock

Changing a scoring field is "read stored fields, merge, compute, write". Two requests changing
different scoring fields would each compute from a stale row and the last write would drop the
other's points. So **only an update that changes a scoring field** runs in a transaction that takes
`acquireLock(tx, 'lead', id)`, reads the row (with visibility), computes, and writes. Owner, name and
notes changes take no lock and leave the score alone (tests: a held lead lock blocks a scoring PATCH
but not a notes/owner PATCH; a stored score of 77 survives a notes edit; three concurrent PATCHes of
different scoring fields always end at the right score, and the test fails with the lock removed).
Create needs no lock: the row does not exist yet.

## Lock ordering (shared with Phases 6/7 and the coming conversion)

A transaction takes **one** lock. If a flow ever needs more, the order is **org, then lead, then
company** (`advisory-lock.ts`). Phase 9 conversion will take the lead lock first (so two conversions
of one lead serialise, and so do conversion and a scoring update) and then, if it links or creates a
company, the company lock. 8a takes only the lead lock, and only in the update described above.

## `companyName` is free text

A lead has no foreign key to `Company`; the company is created or linked at conversion. Deleting a
company can therefore never break a lead (tested: a lead named after a soft-deleted company still
reads).

## 8b: status workflow

`POST /leads/:id/status` with body `{ "status": "<target>" }` (permission `leads:update`). `POST`, not
`PATCH`: it is an action with its own rules and its own errors, not a field edit.

- **Transitions** (`lead-status-transitions.ts`): `NEW -> CONTACTED | UNQUALIFIED`,
  `CONTACTED -> QUALIFIED | UNQUALIFIED`, `QUALIFIED -> UNQUALIFIED`, `UNQUALIFIED -> CONTACTED`.
  `CONVERTED` is reachable only through lead conversion (Phase 9). It is not a valid target (the DTO
  answers `400 VALIDATION_FAILED`: this is wrong for every lead, so it says nothing about this one)
  and it leads nowhere.
- **Reopen returns to `CONTACTED`, not `NEW`:** the lead has already been contacted; `NEW` would
  erase that history and put it back in the "untouched" queue. It also skips `QUALIFIED`, because a
  lead that was disqualified must be re-evaluated, not silently re-qualified.
- **Same status is a conflict:** `NEW -> NEW` is not in the map, so it answers
  `409 INVALID_STATUS_TRANSITION`. The change is deliberately **not idempotent**: retrying a change
  that was already applied also answers 409, and the client should `GET` the lead to confirm its
  status (also stated in Swagger). Idempotence would need request ids; nothing asks for it.
- **The "from" is never client input.** The body has only `status`; any other field (`from`,
  `score`, `ownerId`, `convertedAt`...) is a `400`. The service reads the lead (with the caller's
  visibility) and the move is computed from the status it just read.
- **Compare-and-set**, shared as `common/utils/status-transition.util.ts` (`TransitionMap` +
  `applyStatusTransition`) because Deals and Tasks have the same shape: read with visibility, check
  the map, then ONE conditional update whose `where` has `status = <what was read>` plus visibility.
  No lock: the write is a single atomic statement. If it matches nothing the helper reads again,
  with the same visibility: gone or hidden -> `404`; otherwise a `409` (see below) naming the
  status it is now.
- **Status is excluded from the score.** The score describes the lead's attributes, so
  `UNQUALIFIED` does not zero it (sorting by score still means "how promising is this contact data").
  A status change therefore never changes the score, cannot make it stale, and takes no lock (tested
  with the lead lock held by another transaction). A unit test asserts `status` is not in
  `SCORING_FIELDS`. If status ever enters the score (for example as a multiplier), `status` must join
  `SCORING_FIELDS` and the status change must recompute inside the same transaction as the
  compare-and-set, under the lead lock.
- **A converted lead is final.** `PATCH` (including an owner transfer) and `DELETE` carry
  `status != CONVERTED` in the same `where` as the write; when they match nothing the service looks
  again with visibility: a visible converted lead -> `409 LEAD_ALREADY_CONVERTED`, anything else ->
  `404`. An invisible converted lead is always `404`, so its state is never revealed. `GET` and the
  list still return it. An empty `PATCH` body is a `400` before any of this. Phase 9 decides any
  exception to the owner-transfer block.

### The two 409 codes (for frontend handling)

| Code                        | Meaning                                                                                                                                  | What the UI does                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `LEAD_ALREADY_CONVERTED`    | The lead is final: it was converted (a status change, edit or delete was attempted)                                                      | Stop editing; show the lead read-only and link to the contact/deal it became   |
| `INVALID_STATUS_TRANSITION` | That status change is not possible from the lead's current status (not in the map, same status, or the status changed under the request) | `GET` the lead, refresh the status, offer only the moves that are possible now |

Both are `409` and both mean "your picture of the lead is out of date or not allowed"; the code tells
the client whether to freeze the record or just refresh it.

### Deferred: status history

`LeadStatusHistory` (who changed the status, from what, when) is **not** built in 8b. It belongs to
Phase 13 (Activities and Audit logs), which will record it from a `lead.status_changed` domain event;
adding a table now would duplicate that. Until then `updatedAt` is the only trace.

## Phase 9: lead conversion

`POST /leads/:id/convert` (`leads:convert`). Body, all optional: `contactId`, `companyId`,
`createCompany`. Response: `{ lead, contact, createdCompany }`. Code: `LeadConversionService`
(orchestration across modules, through their SERVICES) and `LeadsRepository.convert` (transaction,
locks, claim).

### One transaction

1. `applyStatusTransition` (shared helper) reads the lead with visibility and checks
   `LEAD_CONVERSION_TRANSITIONS`: **only `QUALIFIED` converts.** Upgrade path: allow `CONTACTED` by
   adding `CONVERTED` to that entry. Other statuses answer `409 INVALID_STATUS_TRANSITION`, a
   converted lead `409 LEAD_ALREADY_CONVERTED`.
2. `LeadsRepository.convert`: lead lock, then the lock of the company or contact being linked
   (order **org, lead, company, contact**, `advisory-lock.ts`), then the **claim**: one conditional
   update (`status = QUALIFIED` + visibility) that sets `CONVERTED` and `convertedAt` and returns the
   lead's CURRENT data. The new records are built from that, never from the earlier read.
3. The service's `work` creates or links the records through `ContactsService` / `CompaniesService`
   methods that take the transaction (`createWithin`, `assertLinkable`), then the contact id is
   written to the lead. Anything that throws rolls everything back, the claim included.
4. After the commit: `lead.converted` is emitted.

### Options (a lead has no `companyId`, only free-text `companyName`)

| Body                          | Result                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{}`                          | New contact from the lead (name, email, phone), no company. `companyName` stays text.                                                            |
| `companyId`                   | New contact under that existing company (visible to the caller, checked under the company lock; else `400 INVALID_COMPANY`)                      |
| `createCompany: true`         | New company named after `companyName`, new contact under it. Lead without a company name: `400`                                                  |
| `contactId`                   | Existing contact linked as it is: **never modified** by lead data (visible and live, else `400 INVALID_CONTACT`)                                 |
| any contradictory combination | `400 INVALID_CONVERSION_OPTIONS`; the body never "wins": `contactId` excludes the other two, `companyId` excludes `createCompany`                |
| `deal` (Phase 10d)            | Accepted since Phase 10d: it creates a deal in the same transaction (ADR 0009). An unknown field, inside `deal` too, is `400 VALIDATION_FAILED`. |

New contacts and companies belong to the **lead's owner**, not to the caller (a manager converting a
rep's lead does not take the records). That goes through `ownerForCreate`, so an inactive owner is
`400 INVALID_OWNER` (reassign the lead first). The score and every other lead field are untouched.

### Permissions follow what happens

`leads:convert` always; `contacts:create` only when a contact is created; `companies:create` only
when a company is created. Linking an existing contact needs `leads:convert` alone. The extra
checks run in the service (403 `FORBIDDEN`, before anything is read or written).

### The contact lock

Linking an existing contact is "check, then write". Without a lock a contact could be deleted
between the check and the write, leaving a CONVERTED (final) lead pointing at a deleted contact. So
the conversion holds `'contact'` while it checks and links, and `ContactsRepository.deleteVisible`
takes the same lock. Whoever is second sees the first: a delete that wins makes the conversion
answer `400 INVALID_CONTACT` (nothing written); a conversion that wins links a live contact, which
may then be deleted like any contact (a normal later deletion; Phase 10 decides whether open
deals/leads block it, see the TODO in PROJECT_STATUS).

### Event `lead.converted`

Payload: `organizationId, leadId, contactId, companyId, dealId (null until Phase 10), ownerId,
actorId, convertedAt`. Ids and the tenant only, no personal data; listeners load details through the
owning services. It is emitted after the commit and never inside the transaction. A listener that
throws (synchronously or by rejecting) is caught, logged with the lead id, and never reaches the
caller.

**Known gap:** the event is in-process and emitted after the commit. If the process dies between the
commit and the emit, the event is lost and the lead stays converted with no follow-up. Phase 12
(BullMQ, with an outbox row written in the same transaction if exactly-once matters) closes it.

### Limitations

- **Duplicates are allowed.** The ERD has no uniqueness on contact or company email/name, so
  converting two leads with the same email creates two contacts. A dedupe step (match by email on
  conversion, suggest `contactId`) is a TODO in PROJECT_STATUS.
- `LeadStatusHistory` is still deferred to Phase 13: the conversion is traceable through
  `convertedAt` / `convertedContactId` only.
