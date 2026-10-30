# SalesFlow CRM

Multi-tenant CRM backend built with NestJS, TypeScript (strict), PostgreSQL, Prisma, Redis and BullMQ.

> Status: under construction. See `PROJECT_STATUS.md` for the current phase and `CLAUDE.md` for the architecture rules.

## Prerequisites

- Node.js >= 22 (LTS)
- pnpm

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm start:dev
```

The API is served under `/api/v1`.

## Scripts

| Script | Description |
|---|---|
| `pnpm start:dev` | Run in watch mode |
| `pnpm build` | Compile to `dist/` |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript type check |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:cov` | Unit tests with coverage |
