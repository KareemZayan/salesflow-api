# ADR 0004 — Users administration (Phase 6b)

Status: accepted

## Context

Admins create and manage users of their own organization. Several rules span more than one row:
"the organization keeps one active ADMIN", "no management cycles", "no active user under an inactive
manager". Checking and then writing is a race unless something serializes it.

## Decisions

**One advisory lock per organization.** `acquireOrgLock(tx, organizationId)`
(`src/infrastructure/prisma/org-lock.ts`, the only place raw SQL is allowed) takes
`pg_advisory_xact_lock`. Every write that changes `isActive`, `roleId` or `managerId` (create,
update, deactivate, reactivate, reset-password) runs in `UsersRepository.withOrgLock`, and the
cross-row checks (last admin, cycle, active reports, manager state) run _inside_ the transaction
after the lock. Row locks cannot do this: the rows that must not change concurrently are the ones
the check only reads. User administration is low-volume, so one lock per organization costs nothing.
Phase 6c reuses the helper.

**Privilege escalation.** Anything that touches an account whose role is `ADMIN`, or hands out the
`ADMIN` role, requires the caller to be `ADMIN` (`403 ADMIN_REQUIRED`). A custom role holding
`users:update` therefore cannot take over an admin account or promote itself.

**Self protection.** No self-deactivation, no change of your own role, no admin reset of your own
password (use `change-password`, which verifies the current one).

**Last active ADMIN.** Deactivating or demoting an active ADMIN needs another active ADMIN
(`409 LAST_ADMIN_REQUIRED`). Through the API this can only be reached by a race (two admins removing
each other), because self-removal is blocked and non-admins cannot touch admins; the lock is what
makes that race safe.

**Managers.** The manager must exist in the organization (the scoped client hides other tenants),
be active, not be the user, and not create a cycle. Deactivating a user with active direct reports
fails with `409 USER_HAS_ACTIVE_REPORTS`; reactivating a user whose manager is inactive fails with
`409 INVALID_MANAGER`. Together they keep "active user ⇒ active manager (or none)". No role is
required of a manager: visibility (6c) only reads `managerId`.

**Sessions.** Deactivation and password reset revoke every refresh token in the same transaction
through `SessionRevoker` (exported by `AuthModule`, takes the caller's transaction client; also used
by change-password). Access tokens die at once on deactivation because the guard reloads `isActive`
per request; after a reset they live until they expire, like in change-password.

**Email.** Globally unique (ERD). The scoped client cannot see other organizations, so there is no
pre-check: the unique index decides and `P2002` becomes `409 EMAIL_ALREADY_EXISTS`. The message never
says where the clash is, although the status itself reveals that the email exists somewhere
(accepted for an admin-only endpoint).

**Passwords.** The admin supplies the temporary password (`temporaryPassword`); it is never returned
or logged (pino redacts it, see `LOG_REDACT_PATHS`). `mustChangePassword` is set.

**Visibility.** `users:read` is granted to `SALES_MANAGER` too, so a manager sees **all** users of
the organization, read-only (not just their team). Narrowing it to the team belongs to the
ownership scoping work in 6c if the product needs it.

**Responses.** The repository uses an explicit `select`; `passwordHash` is never loaded.

## Consequences

- Audit logging of deactivate / reset / role change is a Phase 13 item. Until then the service emits
  structured log events (`user.deactivated`, `user.role_changed`, ...) with ids only.
- There is no delete endpoint: users are deactivated, never deleted (ERD).
