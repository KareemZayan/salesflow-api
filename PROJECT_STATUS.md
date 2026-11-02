# PROJECT_STATUS

## Current phase

Phase 6d — Organizations — done, awaiting your review/commit. **Phase 6 is complete** (6a Auth core, 6b Users, 6c Roles + visibility, 6d Organizations).

## Completed phases

- Phase 1 — Bootstrap ✅ (2026-10-30)
- Phase 2 — Docker & infrastructure ✅ (2026-10-30)
- Quality gates (Husky / lint-staged / commitlint) ✅ (2026-10-30)
- Phase 3 — ERD review ✅ (2026-10-31)
- Phase 4 — Prisma schema, init migration, idempotent seed, Docker startup ✅ (2026-10-31)
- Phase 5 — Common layer (filter, pagination, decorators, tenant context, Prisma scoping extension) ✅ (2026-10-31)
- Phase 6a — Auth core (login/refresh/logout/me/change-password, JWT strategy, global guards, throttling, helmet, mustChangePassword migration) ✅ (2026-10-31)
- Phase 6b — Users (admin CRUD, deactivate/reactivate, manager assignment, admin reset-password, org advisory lock, SessionRevoker) ✅ (2026-10-31)

- Phase 6c — Roles API + OwnershipScopeService (own/team/all), role-assignment escalation fix in Users, seed no longer re-grants trimmed permissions ✅ (2026-11-01)
- Phase 6d — Organizations (GET/PATCH /organizations/current, idempotent `org:create` CLI, shared policy files, Phase 6 close-out) ✅ (2026-11-02)
- **Phase 6 — Organizations, Auth, Users, RBAC ✅ complete**

## Decisions log

- 2026-10-30 — NestJS 11 (CommonJS), not 12 — v12 is ESM-only; ESM would add `.js` import suffixes and ecosystem risk (Prisma, nestjs-cls, bull-board)
- 2026-10-30 — TypeScript ^6, not 7 — Nest CLI and typescript-eslint don't support TS 7 yet; revisit when they do
- 2026-10-30 — `tsconfig` uses module/moduleResolution `node16`; `rootDir: ./src` set in tsconfig.build.json (TS 6 requirement)
- 2026-10-30 — `vitest.config.mts` (ESM-only Vite) while the package stays CommonJS
- 2026-10-30 — pnpm 11 `pnpm-workspace.yaml` has `allowBuilds` for `@swc/core` (build script approval)
- 2026-10-30 — Env schema only has keys used so far; later `.env.example` sections are consumed by later phases
- 2026-10-30 — `@nestjs/terminus` pinned to ^11 — v12 is ESM-only (same reason as Nest 12); Vitest hides this but `tsc`/`nest build` reject it
- 2026-10-30 — `/health` and `/health/ready` live outside the `/api/v1` prefix (stable path for orchestrators)
- 2026-10-30 — Readiness is a TCP-connect probe for Postgres/Redis (no ioredis, approved). Replace with Prisma / BullMQ-based checks in Phases 4 and 12
- 2026-10-30 — `configureApp()` in `src/app.setup.ts` is shared by `main.ts` and e2e tests (single source of app wiring)
- 2026-10-30 — Compose `api` forces `NODE_ENV=production` (pino-pretty is dev-only); `docker-compose.override.yml` is the committed dev setup (hot reload, DB/Redis published on 127.0.0.1)
- 2026-10-30 — Queue in e2e: not decided yet (decide in Phase 12)

- 2026-10-30 — Husky 9 + lint-staged + commitlint (conventional) added. Hooks: pre-commit = lint-staged (eslint --fix + prettier), commit-msg = commitlint. No typecheck in the hook (CI runs it in Phase 16). `prepare` is `husky || true` so Docker prod installs (no husky, no .git) don't fail

- 2026-10-31 — ERD approved (`docs/erd.md`, 17 entities incl. `DealStageHistory`). Locked: global unique login email; composite FKs `(id, organizationId)` on tenant relations; `Restrict` by default (no `SetNull`), users deactivated never deleted, no org deletion in app; no uniqueness on contact/company/lead email or name; `Activity` has nullable FKs, only `AuditLog` is polymorphic; org onboarding via idempotent CLI script (no public endpoint); money `Decimal(14,2)` + `Organization.defaultCurrency`; RLS deferred to Phase 15; scoping via Prisma client extension (finalized in Phase 5)
- 2026-10-31 — Raw-SQL pieces needed in the Phase 4 migration: partial unique index (one default pipeline per org) and partial index on open tasks `(status, dueDate)`

- 2026-10-31 — Phase 4 pre-checks passed: nullable composite FKs (`Task.dealId`, `Contact.companyId`, `User.managerId`) validate, generate plain `FOREIGN KEY (xId, organizationId)` (MATCH SIMPLE: null skips the check, cross-org is rejected by Postgres). Raw-SQL partial indexes in the init migration leave `migrate dev` and `migrate diff` empty, so no workaround is needed
- 2026-10-31 — Prisma pinned to 7.10.1 (exact). `pnpm add prisma` resolved to 8.0.0-rc.28, which does not match client 7. Config in `prisma.config.ts`; client generated to `src/generated/prisma` (gitignored, CJS); driver adapter `@prisma/adapter-pg`
- 2026-10-31 — Deviation from ERD: `Lead.convertedContactId` is NOT unique (several leads can link to one existing contact); `convertedDealId` is unique (one lead creates one deal)
- 2026-10-31 — `tsx` moved to `dependencies`: the runtime image runs the seed with it (`docker/entrypoint.sh`), so the prod image needs no second build step
- 2026-10-31 — Seed rules: never overwrites an existing admin password, renamed pipeline or role grants; refuses the placeholder password and `SEED_DEMO_DATA=true` when `NODE_ENV=production` (so the prod-like compose needs a real `SEED_ADMIN_PASSWORD`); demo users are `manager@example.com` / `rep@example.com` with the seed password
- 2026-10-31 — PrismaService connects lazily (no `$connect` on init); `/health/ready` uses Terminus `PrismaHealthIndicator`. Redis is still a TCP probe until Phase 12
- 2026-10-31 — Integration tests: `pnpm test:integration` (`vitest.integration.config.mts`) needs the compose `postgres`; the global setup creates and migrates `TEST_DATABASE_URL`, and both setup and suite refuse any DB whose name does not end with `_test`

- 2026-10-31 — Phase 6 split into 6a Auth core, 6b Users, 6c Roles + visibility (OwnershipScopeService), 6d Organizations; one branch/PR each. 6a branch: `feat/phase-6a-auth-core`
- 2026-10-31 — Auth design in ADR 0003: access JWT (HS256, pinned alg, iss/aud, claims sub+org only, user/role/permissions/org status reloaded in ONE query per request), opaque refresh tokens (SHA-256 stored, rotation per family, atomic via conditional updateMany), refresh token in the JSON body (revisit httpOnly cookie when a frontend exists)
- 2026-10-31 — TOKEN_ROTATED_RECENTLY is **409** (not 401) so clients do not log out; only while the family still has a live token (else 401 INVALID_REFRESH_TOKEN). Replay after REFRESH_REUSE_GRACE_SECONDS (10) = 401 TOKEN_REUSED + family revoked
- 2026-10-31 — Added `User.mustChangePassword` (migration `add_user_must_change_password`, ERD + seed updated; seeded admin = false). Locked routes answer 403 PASSWORD_CHANGE_REQUIRED except `me`/`change-password` (`@AllowWhenPasswordChangeRequired()`)
- 2026-10-31 — `@nestjs/jwt` and `@nestjs/passport` pinned to ^11: v12 is ESM-only (same reason as Nest 12 / terminus)
- 2026-10-31 — Env: removed JWT_REFRESH_SECRET; added TRUST_PROXY, REFRESH_REUSE_GRACE_SECONDS; reused existing THROTTLE_* vars. Local `.env` got a generated JWT_ACCESS_SECRET (min 32 chars now enforced)
- 2026-10-31 — Throttling: two named throttlers, `default` and `auth` (`@AuthThrottle()`; tracker = IP + normalized email); in-memory storage (per instance, resets on restart) — move to Redis before scaling out. Auth 429 sends `Retry-After-auth` (named-throttler header suffix)
- 2026-10-31 — e2e now needs real Postgres (`pnpm test:e2e`, shares the integration global setup, runs files serially); `pnpm test` stays DB-free. Suites needing data use `createTestApp()` (switches DATABASE_URL to the _test DB); default e2e env keeps an unreachable DB and sky-high throttle limits
- 2026-10-31 — helmet enabled (CSP relaxed for the Swagger path only, dev-only); health endpoints are `@Public()` + `@SkipThrottle`

- 2026-10-31 — 6b design in ADR 0004: one advisory lock per org (`acquireOrgLock`, infrastructure/prisma/org-lock.ts, the only raw SQL) around every write to isActive/roleId/managerId, checks inside the tx; only an ADMIN may touch an ADMIN account or assign the ADMIN role (ADMIN_REQUIRED); no self-deactivate / self role change / admin self-reset; INVALID_MANAGER on inactive manager at reactivation; USER_HAS_ACTIVE_REPORTS blocks deactivation; email clash decided by the unique index (P2002 → EMAIL_ALREADY_EXISTS), no pre-check because the scoped client cannot see other orgs
- 2026-10-31 — `SessionRevoker` (exported by AuthModule, takes a tx client) is the single "revoke all refresh tokens of a user"; AuthRepository.replacePassword now uses it. SALES_MANAGER has users:read, so managers see ALL org users read-only
- 2026-10-31 — pino redact paths extracted to `LOG_REDACT_PATHS` (password, temporaryPassword, newPassword, currentPassword, passwordHash, refreshToken + authorization/cookie) with a spec

- 2026-11-01 — 6c design in ADR 0005: `assertMayGrant` (common/utils) is the single escalation rule, used by Roles (create/edit/delete) and Users (role assignment; closes the 6b gap). System roles are identified by `isSystem` + reserved names (ADMIN frozen; other system roles: permissions editable, no rename/delete). Role names: trimmed, max 50, case-insensitive unique under the org lock (P2002 backstop). ROLE_IN_USE counts inactive users. List uses `_count` (no N+1). Permission replace = deleteMany + createMany in one tx under the lock
- 2026-11-01 — Seed grants default permissions only when it CREATES a system role; only ADMIN is synced with the full catalogue (a re-run no longer restores permissions an admin removed from SALES_MANAGER / SALES_REP)
- 2026-11-01 — Visibility: ADMIN all, SALES_MANAGER own + direct reports (inactive reports included), every other role own-only (fail closed; upgrade path = future Role.visibilityScope column + migration). Per-request CLS cache only; `resolve(undefined)` throws 401. `applyVisibility` ANDs with the caller's where; ownerless records are admin-only until Phase 8 decides
- 2026-11-01 — `GET /permissions` is intentionally unpaginated (fixed global catalogue, ~34 rows)
- 2026-11-02 — 6d design in ADR 0006: `GET/PATCH /organizations/current` (no :id; GET open to any authenticated user, PATCH needs `organizations:update`; only name + defaultCurrency editable, slug/isActive never via API). `org:create` CLI reuses `seedOrganization` (generated one-time password on stdout, `mustChangePassword`, idempotent on slug, P2002 race re-check, ADMIN verified). Runs in Docker via `tsx` exactly like the seed (the seed is NOT compiled to JS; tsx is a prod dependency since Phase 4)
- 2026-11-02 — Shared pure policy files in `src/common/policies/` (password, currency, organization): one definition used by the API, the seed and the CLI. The runtime image copies this folder (Dockerfile) because the seed/CLI import it. Seed length rule is now 10-128 (was 12); the placeholder password is still refused only in production
- 2026-11-02 — `@OptionalButNotNull()` (common/validators) replaces `@IsOptional()` on NOT NULL PATCH fields: `null` was reaching Prisma as a 500 (found in Users/Roles DTOs while building 6d; fixed + tested)
- 2026-11-02 — **Deferred to Phase 15:** `org:set-active` CLI (deactivate/reactivate an organization; the JWT strategy already honors `Organization.isActive`, nothing can toggle it except SQL)

## Open questions

- None.

## Next step

Phase 7 — Companies & Contacts (first consumer of `OwnershipScopeService`; reuse `@IsCurrencyCode`/policies where relevant) — only when you ask.

## Notes for next session (to save context)

- Config: `src/config/` (zod `env.schema.ts`, `validate-env.ts`, `app.config.ts` registerAs `app`). Never read `process.env` outside config.
- Tests: unit `*.spec.ts` next to code (`pnpm test`); e2e in `test/e2e/*.e2e-spec.ts` (`pnpm test:e2e`, `vitest.e2e.config.mts`, forces unreachable DB/Redis ports and silent logs).
- Docker: `pnpm docker:up` = dev (override, hot reload). Prod-like: `docker compose -f docker-compose.yml up --build`. Set `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` in `.env` if local ports are taken (6379 was taken on the owner's machine).
- `docker/entrypoint.sh` waits for DB, runs `prisma migrate deploy` and the idempotent seed (via `tsx`, a prod dependency; the runtime image has no pnpm), then `exec`s the command. `.gitattributes` forces LF on `*.sh`.
- pnpm needed `pnpm install --config.confirmModulesPurge=false` once (node_modules pointed at an old virtual store location).
- Logger: `src/infrastructure/logger` (nestjs-pino; request id via `x-request-id`, auth/cookie headers redacted).
- Skeleton folders keep a `.gitkeep` only while empty (`src/common/interceptors`, `src/infrastructure/queue`, `src/jobs`); delete it when the first real file arrives.
- Prisma: after `pnpm install` run `pnpm prisma:generate` (`build` and `start:dev` do it automatically). Seed locally: `pnpm db:seed`. New migration: `pnpm prisma:migrate` (never edit an applied one).
- Nested Prisma writes through a composite FK must NOT pass `organizationId` (it comes from the parent). Flat creates must pass it.
- Do not run `docker compose -f docker-compose.yml ...` while using the dev stack: it recreates `postgres` without the published port. Fix with `docker compose up -d postgres`.
- Another project's Postgres/Redis (eltamam) runs on this machine (Redis on 6379), so Redis health can look "up" for the wrong reason.
- Common layer: `src/common/` (`common.module.ts` is global: ClsModule, TenantContextService, APP_FILTER). Repositories inject `@Inject(PRISMA_TENANT) prisma: TenantPrismaClient`; never `PrismaService` outside the allowed folders (ESLint).
- Lists: extend `PaginationQueryDto`, use `toSkipTake`, `toOrderBy(query, allowedFields, fallback)`, `buildPaginated`; cursor lists use `CursorQueryDto` + `buildCursorPage`. Business errors extend `DomainException(code, message, status)`.
- Auth: `modules/auth` (AuthRepository uses the unscoped PrismaService on purpose). Guards live in `common/guards` and are registered in order in `CommonModule` (Throttler → JwtAuth → PasswordChangeRequired → Roles → Permissions). `@Public`, `@Roles` (any-of), `@Permissions` (all-of), `@AuthThrottle`, `@AllowWhenPasswordChangeRequired` exist. `@Audit()` is Phase 13. `PasswordService` is exported by AuthModule for the Users module (6b).
- E2E helpers: `test/factories` (resetDatabase, createOrganization via the real seedOrganization, createUser), `test/setup/create-test-app.ts`, `test/support/probe.controller.ts` (test-only @Roles/@Permissions routes).
- Phase 13 TODO: audit-log user.deactivated / user.password_reset / user.role_changed (6b only emits structured log events with ids). Last-active-ADMIN is only reachable via a race through the API (self-removal blocked, non-admins cannot touch admins), so it is covered by the concurrent e2e test + unit tests.
- Visibility (6c): `common/visibility` (`VisibilityModule` exports `OwnershipScopeService`; helpers `ownerWhere`, `applyVisibility`, `assertVisible`). Feature modules import `VisibilityModule`, call `resolve(actor)` once, then `applyVisibility(where, scope, 'ownerId')`. Not wired into any feature yet (Phase 7 is the first consumer); e2e uses the test-only probe controller, and `createTestApp` imports `VisibilityModule` for it.
- Roles (6c): `modules/roles` (RolesController + PermissionsController). Any new role-assignment code must call `assertMayGrant`; role writes go through `RolesRepository.withOrgLock`.
- Phase 12 TODO: scheduled cleanup job for expired/revoked RefreshToken rows (they accumulate until then).
- Git: working-tree files are LF (prettier) while git normalizes to CRLF on commit; `git status` shows many "M" files with no content diff. `pnpm-lock.yaml` was rewritten by pnpm 11.28 (large diff) — check it before committing.
- Integration tests (`pnpm test:integration`) cover the scoping extension against real Postgres; use the same pattern for module isolation tests.
- Soft-deletable relations in `include` are not auto-filtered (ADR 0002 known limits).

## Phase 6 summary (reference; details in ADRs 0003-0006)

- **Auth** (`modules/auth`, ADR 0003): login / refresh (rotating, family revoke) / logout / me / change-password; global guard order Throttler -> JwtAuth -> PasswordChangeRequired -> Roles -> Permissions; `@Public`, `@Roles`, `@Permissions`, `@AuthThrottle`, `@AllowWhenPasswordChangeRequired`. `SessionRevoker` (tx-aware) is the only "revoke all sessions" path.
- **Users** (`modules/users`, ADR 0004): admin CRUD + deactivate/reactivate + admin reset-password; org advisory lock (`acquireOrgLock`, the only raw SQL) around every write to isActive/roleId/managerId; only ADMIN touches ADMIN accounts; no self-deactivate / self role change / self reset.
- **Roles** (`modules/roles`, ADR 0005): CRUD + `GET /permissions`; `assertMayGrant` is the single "cannot grant what you do not hold" rule (also used by Users on role assignment); ADMIN role frozen; system roles by `isSystem` + reserved names.
- **Visibility** (`common/visibility`, ADR 0005): `OwnershipScopeService.resolve(actor)` -> all / owners; `applyVisibility` ANDs the scope into a where; `assertVisible` -> 404. Wired by Phase 7+.
- **Organizations** (`modules/organizations`, ADR 0006): `GET/PATCH /organizations/current`; operator CLI `pnpm org:create` (Docker: `./node_modules/.bin/tsx prisma/seed/create-org.ts ...`).
- **Permissions catalogue** (prisma/seed/permissions.ts): ADMIN is synced with all keys on every seed; other system roles get defaults only when created.
- **Test helpers**: `test/factories` (resetDatabase, createOrganization, createUser, createCustomRole), `createTestApp()`, probe controller. Gotcha: a supertest request binds to its server when created, so always `await signIn()` BEFORE building the request.
- **Commands**: `pnpm test` (unit, no DB), `pnpm test:integration`, `pnpm test:e2e` (both need compose postgres), `pnpm org:create`, `pnpm db:seed`.
- **Intentionally deferred (owner phase)**: refresh-token cleanup job (12); audit logging of user/role/org/password events + `@Audit()` (13); throttler storage in Redis before multi-instance (15); `org:set-active` (15); null-owner record rule (8); `Role.visibilityScope` column (only if custom scopes are needed); httpOnly refresh cookie (when a frontend exists); OpenAPI export, README, CI (16).
