# PROJECT_STATUS

## Current phase
Phase 2 — Docker & infrastructure — done (awaiting your review / commit)

## Completed phases
- Phase 1 — Bootstrap ✅ (2026-10-30)
- Phase 2 — Docker & infrastructure ✅ (2026-10-30)

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

## Open questions
- Husky / lint-staged / commitlint: agreed to do as a separate small step later (repo is now a git repo).

## Next step
Phase 3 — ERD review (`docs/erd.md`, incl. multi-tenancy design) — only when you ask. (Husky/commitlint step can be slotted before it if you prefer.)

## Notes for next session (to save context)
- Config: `src/config/` (zod `env.schema.ts`, `validate-env.ts`, `app.config.ts` registerAs `app`). Never read `process.env` outside config.
- Tests: unit `*.spec.ts` next to code (`pnpm test`); e2e in `test/e2e/*.e2e-spec.ts` (`pnpm test:e2e`, `vitest.e2e.config.mts`, forces unreachable DB/Redis ports and silent logs).
- Docker: `pnpm docker:up` = dev (override, hot reload). Prod-like: `docker compose -f docker-compose.yml up --build`. Set `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` in `.env` if local ports are taken (6379 was taken on the owner's machine).
- `docker/entrypoint.sh` waits for DB then `exec`s the command; migrate/seed lines are commented until Phase 4. `.gitattributes` forces LF on `*.sh`.
- pnpm needed `pnpm install --config.confirmModulesPurge=false` once (node_modules pointed at an old virtual store location).
- Logger: `src/infrastructure/logger` (nestjs-pino; request id via `x-request-id`, auth/cookie headers redacted).
- Skeleton folders hold `.gitkeep` files; remove them when real files arrive.
