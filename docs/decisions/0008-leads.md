# ADR 0008 — Leads (Phase 8)

Status: accepted (8a CRUD + scoring implemented; 8b status workflow planned, decisions recorded here)

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

## 8b (planned): status workflow

Decided now so 8a does not paint 8b into a corner:

- **Transitions:** `NEW -> CONTACTED | UNQUALIFIED`, `CONTACTED -> QUALIFIED | UNQUALIFIED`,
  `QUALIFIED -> UNQUALIFIED`, `UNQUALIFIED -> CONTACTED`. `CONVERTED` is reachable only through lead
  conversion (Phase 9), never through the status endpoint.
- **Reopen returns to `CONTACTED`, not `NEW`:** the lead has already been contacted; `NEW` would
  erase that history and put it back in the "untouched" queue. It also skips `QUALIFIED`, because a
  lead that was disqualified must be re-evaluated, not silently re-qualified.
- **Status is excluded from the score.** The score describes the lead's attributes, so
  `UNQUALIFIED` does not zero it (sorting by score still means "how promising is this contact data").
  Consequence: a status change never changes the score, so it cannot make it stale. If status ever
  enters the score (for example as a multiplier), the status change must recompute inside the same
  transaction as the compare-and-set and under the lead lock, and `status` must join `SCORING_FIELDS`.
- **Compare-and-set:** the transition is one conditional update (`where` has visibility and the
  current status); a lost race answers `409 INVALID_STATUS_TRANSITION`.
- **Converted leads are read-only** (`409 LEAD_ALREADY_CONVERTED` on edit/delete). Any lookup used to
  tell `404` from `409` is visibility-scoped: an invisible lead is always `404`.

## Prepared for Phase 9 (nothing built yet)

The response exposes `convertedAt`, `convertedContactId` and `convertedDealId` read-only; no DTO can
write them. The `leads:convert` permission already exists in the seed. Conversion will add a
repository method that sets them inside its own transaction; `LeadsModule` exports nothing yet.
