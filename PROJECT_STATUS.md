# PROJECT_STATUS

## Current phase

Phase 4 — Prisma schema + migration + seed — done, awaiting your review/commit

## Completed phases

- Phase 1 — Bootstrap ✅ (2026-10-30)
- Phase 2 — Docker & infrastructure ✅ (2026-10-30)
- Quality gates (Husky / lint-staged / commitlint) ✅ (2026-10-30)
- Phase 3 — ERD review ✅ (2026-10-31)
- Phase 4 — Prisma schema, init migration, idempotent seed, Docker startup ✅ (2026-10-31)

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

## Open questions

- None.

## Next step

Phase 5 — Common layer (exception filter, pagination, tenant context and the Prisma scoping extension) — only when you ask.

## Notes for next session (to save context)

- Config: `src/config/` (zod `env.schema.ts`, `validate-env.ts`, `app.config.ts` registerAs `app`). Never read `process.env` outside config.
- Tests: unit `*.spec.ts` next to code (`pnpm test`); e2e in `test/e2e/*.e2e-spec.ts` (`pnpm test:e2e`, `vitest.e2e.config.mts`, forces unreachable DB/Redis ports and silent logs).
- Docker: `pnpm docker:up` = dev (override, hot reload). Prod-like: `docker compose -f docker-compose.yml up --build`. Set `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` in `.env` if local ports are taken (6379 was taken on the owner's machine).
- `docker/entrypoint.sh` waits for DB then `exec`s the command; migrate/seed lines are commented until Phase 4. `.gitattributes` forces LF on `*.sh`.
- pnpm needed `pnpm install --config.confirmModulesPurge=false` once (node_modules pointed at an old virtual store location).
- Logger: `src/infrastructure/logger` (nestjs-pino; request id via `x-request-id`, auth/cookie headers redacted).
- Skeleton folders hold `.gitkeep` files; remove them when real files arrive.
- Prisma: after `pnpm install` run `pnpm prisma:generate` (`build` and `start:dev` do it automatically). Seed locally: `pnpm db:seed`. New migration: `pnpm prisma:migrate` (never edit an applied one).
- Nested Prisma writes through a composite FK must NOT pass `organizationId` (it comes from the parent). Flat creates must pass it.
- Do not run `docker compose -f docker-compose.yml ...` while using the dev stack: it recreates `postgres` without the published port. Fix with `docker compose up -d postgres`.
- Another project's Postgres/Redis (eltamam) runs on this machine (Redis on 6379), so Redis health can look "up" for the wrong reason.
- Skeleton folders: `src/infrastructure/prisma` now has real files (its `.gitkeep` was removed).
