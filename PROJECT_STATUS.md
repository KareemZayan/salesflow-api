# PROJECT_STATUS

## Current phase
Phase 1 — Project bootstrap — done (awaiting your review)

## Completed phases
- Phase 1 — Bootstrap ✅ (2026-10-30)

## Decisions log
- 2026-10-30 — NestJS 11 (CommonJS), not 12 — v12 is ESM-only; ESM would add `.js` import suffixes and ecosystem risk (Prisma, nestjs-cls, bull-board)
- 2026-10-30 — TypeScript ^6, not 7 — Nest CLI and typescript-eslint don't support TS 7 yet; revisit when they do
- 2026-10-30 — `tsconfig` uses module/moduleResolution `node16`; `rootDir: ./src` set in tsconfig.build.json (TS 6 requirement)
- 2026-10-30 — `vitest.config.mts` (ESM-only Vite) while the package stays CommonJS
- 2026-10-30 — pnpm 11 `pnpm-workspace.yaml` has `allowBuilds` for `@swc/core` (build script approval)
- 2026-10-30 — Env schema only has Phase 1 keys (NODE_ENV, PORT, API_PREFIX, API_VERSION, CORS_ORIGINS); later `.env.example` sections are consumed by later phases

## Open questions
- Husky / lint-staged / commitlint postponed until the folder is a git repo (`git init` by you).

## Next step
Phase 2 — Docker & infrastructure (Dockerfile, compose, health checks, logger) — only when you ask.

## Notes for next session (to save context)
- Config: `src/config/` (zod `env.schema.ts`, `validate-env.ts`, `app.config.ts` registerAs `app`). Never read `process.env` outside config.
- Tests live next to code (`*.spec.ts`); Vitest uses `unplugin-swc` for decorator metadata.
- Local `.env` exists (copied from `.env.example`, gitignored).
- Skeleton folders hold `.gitkeep` files; remove them when real files arrive.
