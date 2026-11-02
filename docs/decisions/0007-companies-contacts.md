# ADR 0007 — Companies and Contacts (Phase 7)

Status: accepted (7a Companies implemented; 7b Contacts will extend it)

Companies are the first feature built on the Phase 5/6 blocks: the tenant extension, soft delete,
composite FKs and `OwnershipScopeService`. The decisions below are the template for Leads, Deals
and Tasks.

## Check and act in one statement

A single-record read, update or delete puts `applyVisibility` in the **same `where`** as the
operation. There is no "assertVisible, then write" gap in which the owner could change:

- `GET` is a `findFirst` whose where is `{ id } AND visibility`.
- `PATCH` is one `update` whose where carries the visibility filter (Prisma accepts extra filters on
  a unique `where`). A row that is missing, deleted, in another organization, not visible, or
  **reassigned away from the caller after they loaded it** all match nothing and answer the same 404.
- `DELETE` reads the company (visibility first) inside the transaction, then deletes with the same
  filter.

Result: a rep never edits a record that stopped being theirs. Hidden, missing, foreign and deleted
records are indistinguishable (same status, code and message).

## Owner assignment: `OwnershipScopeService.resolveAssignableOwner`

One method for every owned entity. The new owner must be an **active** user of the caller's
organization **and** inside the caller's scope (rep: themselves; manager: themselves and direct
reports; admin: anyone). Every failure is the same `400 INVALID_OWNER`, so the answer does not reveal
whether an id belongs to another organization, is inactive, or is merely out of reach. The check
lives on `OwnershipScopeService` (not `UsersService`) because `VisibilityRepository` already reads
users and every feature module already imports `VisibilityModule`.

- It runs on create only when the owner differs from the caller, and on `PATCH` only when `ownerId`
  is present **and differs from the current owner**. An unchanged owner is neither checked nor
  written, so a manager can still edit a company owned by a since-deactivated report.
- **Transfers need a manager or an admin.** A rep's scope is themselves only, so a rep cannot hand a
  record to a colleague; the manager (for their team) or an admin does it.

## Deleting a company

Soft delete (the scoped `delete` becomes an update of `deletedAt`). It is **blocked while the company
has live contacts** (`409 COMPANY_HAS_CONTACTS`):

- The count is `_count` through the relation inside `CompaniesRepository`, with an explicit
  `deletedAt: null` in the nested filter (the extension does not filter nested relations, see ADR
  0002; an integration test proves a count without it includes soft-deleted rows). So
  `CompaniesService` does not depend on the contacts module: no `forwardRef`, no cycle.
- It is tenant-scoped but **not visibility-scoped**: other users' contacts block the delete too.
- Order is visibility first (404), then the contacts check (409). A company the caller cannot see is
  a 404 even when it has contacts, so the 409 never confirms that an invisible company exists. The
  message carries no count and no owners.
- Soft-deleted contacts do not block. A contact can therefore never point at a deleted company.

## Keyed advisory locks (`infrastructure/prisma/advisory-lock.ts`)

`acquireOrgLock` is generalised to `acquireLock(tx, 'org' | 'company', id)`; it stays the only place
with raw SQL. The `org` key is exactly `org:<id>` as before, so existing Users/Roles locking is
unchanged (their race tests stay green). The company delete takes `company:<id>`; in 7b, creating or
updating a contact with a `companyId` takes the same lock, so a company cannot be soft-deleted while
a contact is being linked to it. Phase 8 (lead conversion) reuses it.

**Lock-ordering rule:** one lock per transaction. If two are ever needed, take `org` first, then
`company` (the broader scope first), so two transactions can never wait on each other.

## Shared building blocks added

- `OwnedListQueryDto` (`q`, `ownerId` on top of pagination) and `containsAny` (search helper).
- `containsAny` trims `q`, ignores a blank one, and **escapes `%`, `_` and `\`**. An integration test
  against Postgres showed Prisma passes `contains` through to `LIKE` unescaped (`q=%` matched every
  row), so escaping is required, not defensive.
- `assertHasChanges`: an empty `PATCH` body is `400 EMPTY_UPDATE`; a body that merely repeats stored
  values is a normal 200.
- `string-transform.util` (`trimString`, `normalizeEmail`, `trimToNull`, `trimToUndefined`) replaces
  three private copies in Users, Roles and Auth.
- `contact-details-policy`: `HOSTNAME_PATTERN` and `PHONE_PATTERN` (no new package).

## Input rules

- `domain`: trimmed, lowercased, **bare hostname only**. A pasted URL (scheme, path, port) is
  rejected with 400 instead of silently rewritten, so what the client sent is what is stored.
- `phone`: simple pattern (optional `+`, digits, spaces, dots, dashes, parentheses; 5-30 characters).
- Optional columns (`domain`, `industry`, `phone`, `address`) are cleared by `null` or a blank string.
- Unknown fields (`organizationId`, `deletedAt`, `createdAt`, `id`) are 400 through the global
  `forbidNonWhitelisted`. `ownerId` is NOT NULL on `Company` and `Contact`; creation defaults to the
  caller.

## Lists

Offset pagination (company lists are small and not append-heavy). One `where` (filters AND
visibility) feeds both the rows and the total, so the total never counts invisible rows. Sorting is
whitelisted (`name`, `createdAt`, `updatedAt`) with `id` as a tiebreaker. `?ownerId=` only narrows:
for a rep, another user's id yields an empty page (200), not 403 and not data.

## Known limits and upgrade paths

- **Strict visibility model.** A rep sees only their own companies, so in 7b a rep cannot link a
  contact to a company they cannot see (404). The upgrade path is **organization-wide company
  visibility** (companies readable by the whole organization, contacts/deals/leads still
  owner-scoped). That changes the visibility model and needs its own decision.
- **Duplicate companies.** The ERD deliberately has no name or domain uniqueness. Because a rep
  cannot see a colleague's company, two reps can create "the same" company. Org-wide company
  visibility or a later dedupe feature is the fix; it is not solved here.
- Search is `contains` (`ILIKE`); the `(organizationId, name)` index serves prefix sorts, and
  `pg_trgm` is deferred until needed.

## Seed permissions today

`SALES_REP` and `SALES_MANAGER` both hold `companies:delete` and `contacts:delete` (`CRM_WORK`).
"Own records only" for a rep comes from visibility, not from withholding the permission.

## Contact email uniqueness (7b)

To be recorded with 7b: the ERD (decision 4) has **no** uniqueness on contact email, so there is no
unique index; email is trimmed, lowercased and format-validated.
