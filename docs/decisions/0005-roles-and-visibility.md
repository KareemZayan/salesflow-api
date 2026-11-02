# ADR 0005 — Roles API and ownership visibility (Phase 6c)

Status: accepted

## Part 1 — Roles and permissions

**Escalation rule (one helper).** `assertMayGrant(actor, keys)`
(`common/utils/permission-escalation.util.ts`) is the only place that decides "may this caller hand
out these permissions": ADMIN always, everyone else only permissions they hold themselves
(`403 CANNOT_GRANT_PERMISSION`). Roles uses it to create, edit (current _and_ new keys) and delete
roles. Users uses it when a role is assigned (create and update), closing the 6b gap where a user
manager could promote anyone to a stronger role. Self role change is still refused outright.

**System roles.** Identified by the `isSystem` flag (and the reserved names), never by an editable
name. `ADMIN` is frozen completely (an organization must always keep a role that can do everything,
including `roles:manage`). `SALES_MANAGER` and `SALES_REP` cannot be renamed or deleted, but their
permissions can be trimmed or extended. Names `ADMIN`, `SALES_MANAGER`, `SALES_REP` are reserved in
any case, so a custom role can never impersonate a system one. `ADMIN_ROLE_NAME` comparisons elsewhere
(`actor.role`) are safe for the same reason.

**Names.** Trimmed, max 50 characters, unique case-insensitively. The check runs under the
organization lock; the `(organizationId, name)` unique index (`P2002` → `ROLE_NAME_ALREADY_EXISTS`)
stays as the backstop for exact duplicates.

**Locking.** Every role write uses `acquireOrgLock`, the same lock user writes take. "Delete a role
nobody holds" (`ROLE_IN_USE`, inactive users counted) therefore cannot interleave with "assign that
role to a user". The permission set is replaced with `deleteMany` + `createMany` in that same
transaction. `permissionKeys` must be unique (400 otherwise) and is capped at 100.

**Reads.** The list returns permission keys and `userCount` from one query (`_count`), so there is no
N+1. The permission catalogue is a small fixed global list, served unpaginated on purpose.

**Seed.** The seed runs on every container start. It grants default permissions only when it _creates_
a system role; it never re-grants what an admin removed from `SALES_MANAGER` / `SALES_REP`. Only
`ADMIN` is synced with the full catalogue (so new permissions reach it).

**Effect of changes.** Permissions are reloaded on every request, so a role edit applies to signed-in
users on their next call.

## Part 2 — Ownership visibility

`OwnershipScopeService.resolve(actor)` returns a `VisibilityScope`:

| Caller                        | Scope                                       |
| ----------------------------- | ------------------------------------------- |
| `ADMIN`                       | everything in the organization              |
| `SALES_MANAGER`               | own records + records of **direct reports** |
| any other role (incl. custom) | own records only                            |

- **Custom roles fail closed.** The upgrade path for custom scopes is a future
  `Role.visibilityScope` column (enum `OWN | TEAM | ALL`, with a migration and a seed default per
  system role). The resolver's role switch then becomes a column lookup; no caller changes.
- **Team = direct reports only**, no subtree. Reports that are **inactive** stay in the team: their
  historical records must not vanish from the manager's view.
- **Per request only.** The team is loaded once per request and cached in the CLS store (the promise
  is cached, so parallel calls share one query). Nothing is shared across requests, so a team change
  applies on the next call. Outside a request nothing is cached. `resolve(undefined)` throws 401
  rather than guessing a scope.
- **Combining filters.** `applyVisibility(where, scope, field)` ANDs the visibility fragment with the
  caller's `where`; a client-supplied `ownerId` filter can narrow results but never widen or replace
  the scope. `assertVisible(scope, ownerId)` answers **404**, not 403, for records outside the scope.
- **Ownerless records (null owner).** `IN (...)` never matches NULL, so by default only admins see
  them. Phase 8 (Leads, where unassigned leads exist) decides whether unassigned records need a
  shared pool; any such rule must be added to the helpers, not to individual repositories.

## Consequences

- Phase 7+ repositories call `resolve()` once, then `applyVisibility()`; none of them re-implement
  team logic.
- Audit logging of role changes is part of the Phase 13 TODO; structured `role.*` log events carry
  ids only until then.
