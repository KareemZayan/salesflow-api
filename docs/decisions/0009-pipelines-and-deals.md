# ADR 0009: Pipelines and deals

Status: accepted (Phase 10, built in four parts on one branch: 10a pipelines and stages, 10b deals,
10c stage moves, 10d the deal inside lead conversion). Each part appends its section.

## Shared vocabulary

- A **pipeline** is organization-wide configuration (no owner, no visibility filter). The tenant
  client alone keeps other organizations out (404). Access is by permission: `pipelines:read` for
  everyone, `create` / `update` for ADMIN and SALES_MANAGER, `delete` for ADMIN only.
- **SALES_MANAGER can create and edit pipelines and stages. This is a conscious decision**: the
  effect is organization-wide (a renamed stage or a new default pipeline changes every rep's board)
  and managers run their teams' process. An organization that does not want it removes
  `pipelines:create` / `pipelines:update` from the role (roles are editable). Deleting stays ADMIN.
- Stages are identified by **markers, never by name**: `PipelineStage.isWon` / `isLost`. A deal's
  status follows its stage (10c): Won stage = WON, Lost stage = LOST, anything else = OPEN.

## 10a: pipelines and stages

### Invariants

- Every pipeline has **at least one open stage, exactly one Won and exactly one Lost stage, and Won
  and Lost are always the last two positions** (open stages first, in board order, then Won, then
  Lost). Positions are `1..n`.
- Won has probability 100 and Lost 0; **the client can never send either** (the create DTO takes open
  stages only and the server appends the terminal ones with `buildStageRows`; PATCH of a terminal
  stage's probability is `400 TERMINAL_STAGE_PROBABILITY_FIXED`). Open stages accept 0-99. Won and
  Lost can be renamed.
- The service keeps "exactly one" and "last two" under the exclusive pipeline lock. The database
  refuses the worst violations whatever the application does (migration
  `pipeline_stage_terminal_constraints`): at most one `isWon` and at most one `isLost` stage per
  pipeline (partial unique indexes) and no stage that is both (CHECK). "At least one" cannot be a
  constraint; it is the service's job. These objects are raw SQL (Prisma's schema cannot express
  them) and leave `migrate dev` / `migrate diff` empty.
- Names are unique per organization (pipelines) and per pipeline (stages), compared
  **case-insensitively** under the lock; the case-sensitive unique indexes remain as the backstop
  (`P2002` is mapped to the same 409).
- The default template (`DEFAULT_PIPELINE_TEMPLATE`, `common/policies/pipeline-policy.ts`) is the
  single definition used by the seed, `org:create` and `POST /pipelines` without `stages`.
- A new pipeline is never the default, except in an organization that has none.

### Positions: the exact strategy

`(pipelineId, position)` is **not unique** in the database, so rewriting positions never produces a
violating intermediate state and needs no temporary values. Every change that moves positions (add a
stage, delete one, reorder) runs in ONE transaction under the exclusive pipeline lock: read all
stages, compute the final order `[open..., Won, Lost]` (`pipeline-layout.ts`, pure and unit-tested),
write `1..n` only where a position changed. Adding an open stage creates it at its final position
and shifts Won and Lost down by one in the same transaction. A reader's stage query is one statement,
so it sees the order before or after, never a mix. **Upgrade path:** if a unique constraint on
`(pipelineId, position)` is ever added it must be `DEFERRABLE INITIALLY DEFERRED` (or the rewrite
must first move the stages to offset positions such as `+1000`, then to their final ones).

### Default pipeline switch

`PATCH /pipelines/:id { isDefault: true }` runs under the **org lock** in one transaction: unset the
old default, then set the new one, so the partial unique index (one default per organization) is
never violated and no reader sees two (or zero) defaults. `isDefault: false` is a 400: choose another
pipeline instead. Deleting the default is `409 PIPELINE_IS_DEFAULT`; the delete takes the org lock
too, so "make X the default" and "delete X" cannot both succeed.

### Deleting pipelines and stages; do soft-deleted deals block?

**Yes.** `Deal.pipelineId` and `Deal.stageId` (and the history's stage ids) are `RESTRICT` foreign
keys, and a soft delete keeps the row, so a soft-deleted deal still pins its pipeline and stage. The
checks therefore count deals **including soft-deleted ones** (`TenantContextService.withDeleted`) and
answer `409 PIPELINE_HAS_DEALS` / `STAGE_IN_USE` with a message that says "deleted deals included",
instead of letting the database answer with a raw foreign-key error. The counts run **after** the
exclusive lock is held (see below). A stage with only `DealStageHistory` rows is also in use.

### Locks: shared for deal writes, exclusive for structure

`acquireLock(tx, kind, id, mode)` has two modes (`pg_advisory_xact_lock` and `..._shared`).
Order of acquisition, one list for the whole project: **org, lead, pipeline, company, contact**.

| Operation                                                     | Locks                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| Create pipeline, rename, switch default                       | org (exclusive)                                        |
| Delete pipeline                                               | org, then pipeline (both exclusive)                    |
| Add / edit / delete / reorder stages                          | pipeline (**exclusive**)                               |
| Deal create, deal move, deal inside lead conversion (10b-10d) | pipeline (**shared**), then company / contact (shared) |
| Contact / company delete                                      | contact / company (exclusive)                          |

Why: deal writes are frequent and independent of each other, so they hold the pipeline **shared** and
never serialize on it; structure changes are rare, admin-only and must see a stable set of deals, so
they hold it **exclusively**: they wait for in-flight deal writes, hold new ones off, and count deals
only afterwards. A deal write that waited behind a stage delete then finds the stage gone and
answers 400. A transaction never takes a lock exclusively after holding it shared (the upgrade can
deadlock). **Accepted contention:** while a structure change holds the pipeline lock, deal writes to
that one pipeline wait. Structure changes are admin-only and rare (seconds of config work, a few
milliseconds of lock), so this is accepted rather than engineered around.

Tests: deterministic ones hold a lock in an open transaction and prove who waits (shared does not
block shared; shared blocks exclusive; exclusive blocks shared); the loops prove the invariants
(unique, contiguous positions with Won/Lost last under parallel adds and a reorder; exactly one
default under parallel switches; no pipeline-less organization under delete-vs-set-default).
Mutations verified to fail: no pipeline lock on stage changes, no org lock on create/switch/delete,
shared downgraded to exclusive.

## 10b: deals

`/api/v1/deals`: list (visibility + `ownerId`, `pipelineId`, `stageId`, `status`, `contactId`,
`companyId`, `q` on the title), get, create, PATCH, soft delete. Owner-scoped like every owned
entity (`applyVisibility`, `ownerForCreate`, `ownerForTransfer`, single-statement check-and-act).

### Money

- `amount` crosses the API as a **decimal string** (`^\d{1,12}(\.\d{1,2})?$`): a JSON number, an
  exponent (`"1e3"`), a sign (`"-5"`), a third decimal (`"1.234"`), a thousands separator or a blank
  are all `400`. Stored as `Decimal(14,2)`; answered with exactly two decimals. No float is ever
  involved (the global pipe does not convert types, so a number never reaches the regex as a string).
- **`amount` is optional on create and NEVER null**: omitted means `"0.00"` (the column is
  `NOT NULL DEFAULT 0`), and `0.00` is a valid amount (a deal can be opened before it is priced).
  Phase 14 reports can therefore sum `amount` without null handling, and must treat 0.00 as "not
  priced yet" only if the business wants that. PATCH cannot set it to null either.
- `currency` is validated with the existing `IsCurrencyCode` (ISO 4217, upper-cased from input) and
  defaults to `Organization.defaultCurrency`, read through the exported `OrganizationsService`. No
  conversion anywhere; reports in Phase 14 group by currency.
- `expectedCloseDate` is a calendar date `YYYY-MM-DD` (`2026-02-31` is rejected, not rolled over).
- **Money changes are not audited yet.** Until the audit log exists (**TODO Phase 13**), a PATCH
  that changes `amount` or `currency` writes a structured log `deal.money_changed` with the old and
  new values, `dealId`, `actorId` and `organizationId`; no personal data. (The "old" value is the
  one read just before the update; two concurrent edits may log a stale old value. The audit log
  will record the real before/after inside the write.)

### Placement and links

- A new deal goes to the default pipeline's first open stage unless `pipelineId` / `stageId` are
  given; the stage must be an **open stage of that pipeline** (`400 INVALID_STAGE`; a Won / Lost
  stage is not a valid starting point). `INVALID_PIPELINE` for a missing or foreign pipeline. The
  first `DealStageHistory` row (`fromStageId = null`) is written in the same transaction.
- `contactId` / `companyId` must be records the caller can see (`assertLinkable`, one 400 per field
  for missing / deleted / foreign / hidden). The contact's company is **not** required to equal the
  deal's company.
- **Locks on a deal write** (create, and PATCH when a link CHANGES), all **shared**, in the order
  pipeline, company, contact: PATCH takes only the locks of links that change (never the pipeline's,
  it does not touch the stage); `null` unlinks with no lock; an unchanged link is not re-checked.
  Nothing is ever taken exclusively after being held shared. Contact / company delete take their
  lock **exclusively** and count open deals after holding it (below).
- A closed (WON / LOST) deal is **read-only**: PATCH answers `409 DEAL_CLOSED` (status is in the same
  `where` as the write; a re-read with the caller's visibility decides 404 vs 409, so a hidden
  closed deal is never revealed). Reopening is a move to an open stage (10c).

### Contact and company delete blockers

- A contact with an **OPEN, live deal** cannot be deleted (`409 CONTACT_HAS_OPEN_DEALS`), nor a
  company (`409 COMPANY_HAS_DEALS`). Closed deals and soft-deleted deals do not block: they keep
  only the id, and reading them never joins the contact or company, so a deal, a converted lead or
  a list never fails (or 500s) because the record it points at was deleted.
- Visibility is checked first (a hidden record is 404, never 409); the count is **not**
  visibility-scoped (another user's deal blocks too) and the message carries no count.
- **A contact referenced by a converted lead's `convertedContactId` stays deletable.** The lead
  keeps only the id; blocking would make every converted contact undeletable forever. Linking a
  deleted contact is prevented at link time by the contact lock, so the lead never points at a
  contact that was already deleted when it was converted.
- Tasks (Phase 11) will add their own blocker to the same two methods.

## 10c: stage moves, won / lost, history

`POST /deals/:id/move { stageId, lostReason? }` (`deals:update`) and `GET /deals/:id/history`
(`deals:read`, follows the deal's visibility, newest first, offset pagination: one deal has a handful
of changes and the list is always scoped to a single deal).

- **Any stage of the deal's own pipeline**, backwards included; another pipeline's or organization's
  stage is `400 INVALID_STAGE` (one answer for missing, foreign and deleted-meanwhile). Moving to the
  stage the deal is already in is `409 INVALID_STAGE_MOVE` (not idempotent, like the lead status).
- **The status follows the stage** (`deal-move.ts`, pure): Won stage = WON + `closedAt`; Lost stage
  = LOST + `closedAt` + `lostReason` (**required**, trimmed, max 500: `400 LOST_REASON_REQUIRED`;
  sending a reason for any other target is `400 LOST_REASON_NOT_ALLOWED`); an open stage = OPEN.
- **Reopening** a WON or LOST deal is allowed **only** as a move to an open stage: `closedAt` and
  `lostReason` are cleared, the deal is editable again, and the history keeps the whole story (the
  move out of the terminal stage is a row like any other). A direct WON to LOST move is a normal move
  (it needs the reason).
- **Compare-and-set.** The move reuses `applyStatusTransition` (rule = "not the same stage", a new
  predicate form of the rule next to the static map, covered by its own tests): the deal is read with
  the caller's visibility, then ONE conditional update matches only while `stageId = <the stage that
was read>` and visibility still holds, and sets stage, status, `closedAt` and `lostReason`
  together. A lost race re-reads and answers `409 DEAL_STAGE_CHANGED` (GET the deal and decide);
  `404` if it became invisible. Two racing moves can therefore never both win.
- **History is written in the same transaction as every move**, and only after the compare-and-set
  matched (a lost race writes nothing). `DealsRepository.recordStageChange` is the single writer
  (the creation row of 10b uses it too). The history rows chain: each `fromStageId` is the previous
  row's `toStageId`, which a test asserts under parallel moves.
- **Locks:** the move holds the pipeline lock **shared**, so a stage delete or reorder (exclusive)
  waits for it and a move waits for them, while moves of different deals never wait for each other.
  The pipeline of a deal never changes, so the id read before the transaction names the right lock;
  the destination stage is checked inside the transaction, under the lock.
- **History responses** carry the stage ids and names and the id of the user who made the change (no
  personal data). The names come with the page through the relations of the same `select`: Prisma
  batches each relation into one `IN (...)` query for the whole page, so the number of statements is
  constant, never one lookup per row.
- **Event `deal.stage_changed`** (ids, resulting status, tenant; no title or amount) is published
  after the commit through `publishDomainEvent` (`common/events`), the helper extracted from the
  lead conversion (its specs were not edited): a listener that throws or rejects is logged and never
  reaches the caller. The same known gap as `lead.converted`: lost if the process dies between the
  commit and the emit (Phase 12 closes it).

Tests: reopen (WON and LOST) clears the fields and writes history; parallel moves (2 and 6) leave
one winner per step with a chained history; move versus stage delete never produces a 500; move
versus edit of an open deal; deterministic lock tests. Mutations verified to fail: the compare-and-set
without `stageId = from`, no pipeline lock on the move, and writing the history regardless of the
compare-and-set result.

## 10d: the optional deal inside lead conversion

`POST /leads/:id/convert` accepts `deal: { title, amount?, currency?, pipelineId?, stageId?,
expectedCloseDate? }` (`ConvertDealDto` = the same fields and validation as `POST /deals`, picked from
`CreateDealDto`; links and owner are deliberately not accepted: they are derived, and sending them is
a 400). The response gains `deal` (null when none was requested); `lead.convertedDealId` and the
event's `dealId` are set.

- **Same transaction as everything else.** `LeadsRepository.convert` takes the locks in the
  project-wide order **lead, pipeline (shared), company or contact**, claims the lead, and the
  service's `work` creates or links the contact and company and then the deal through
  `DealsService.createWithin(tx, ...)` (pipeline and stage are verified there, under the pipeline
  lock; the first `DealStageHistory` row is written by the same repository method as `POST /deals`).
  Any failure, an invalid pipeline or stage included, rolls back the claim, the contact, the company
  and the deal together. Only a conversion that creates a deal takes the pipeline lock, and only
  shared: deal conversions do not wait for each other, a stage or pipeline delete (exclusive) waits
  for them, and a conversion without a deal ignores the pipeline entirely.
- **Why the order matters here.** A conversion that took the company lock before the pipeline lock
  could deadlock with a deal write (pipeline, then company) once an exclusive stage delete is queued
  between them, because Postgres queues a new shared request behind a waiting exclusive one. The
  pipeline id is therefore resolved BEFORE the transaction (`DealsService.resolveDefaults`: the
  organization currency and the default pipeline, the same fallbacks `POST /deals` uses) so the lock
  can be taken in order; the placement is re-verified under it.
- **Links and owner.** The deal is linked to the contact the conversion produced (created or the
  existing one) and to that contact's company (the created one, the linked one, or the existing
  contact's own company). It is owned by the **lead owner** (through `ownerForCreate`, like the new
  contact and company), and `changedById` of its first history row is the person who converted.
- **Permissions follow what happens:** `deals:create` is required only when `deal` is sent; creating
  a contact still needs `contacts:create`, and linking an existing contact with a deal needs
  `leads:convert` + `deals:create` and nothing else.
- **The score and every other lead field are untouched**, as in Phase 9. The event is published
  after the commit with the same known gap (lost if the process dies between commit and emit; Phase
  12).
- The Phase 9 e2e assertions that changed because the contract changed on purpose: "a `deal` field is
  rejected" became "a `deal` is accepted; an unknown field inside it is rejected", and the exact
  response shape gained `deal: null`. Every other Phase 9 assertion, and all Phase 9 unit
  assertions, are unchanged (the unit spec only gained the new constructor dependency).

Tests: the deal with created / linked contact and company, explicit placement, history row, the
event's `dealId`, permissions, validation, full rollback for each invalid pipeline / stage case,
double and triple parallel conversions (exactly one deal), conversion versus stage / pipeline /
company deletes (never a 500, exactly one side wins), and deterministic lock tests. Mutations
verified to fail: no pipeline lock in the conversion, and the pipeline lock taken exclusively.
