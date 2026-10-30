# CLAUDE.md — SalesFlow CRM

> Permanent instructions for Claude Code. Read this file fully at the start of every session.
> Then read `PROJECT_STATUS.md` to know exactly where we are. Do NOT scan the whole repo.

---

## 0. THE MANDATORY WORKFLOW (non-negotiable — read this first)

Every unit of work follows these 6 steps, in this exact order. No exceptions, no shortcuts, even for "small" changes.

```
1. ANALYZE
   Understand the request and read ONLY the files related to the current phase.

2. PLAN
   Explain which files you will add or modify, and WHY for each one.

3. WAIT FOR APPROVAL
   STOP. Wait for my explicit approval before touching any code.

4. IMPLEMENT
   Implement ONE complete feature (code + tests + Swagger + migration if needed).

5. TEST & REVIEW
   Run the tests. Review the code and the architecture against this file.

6. REPORT & STOP
   Summarize what was done, state the next phase, update PROJECT_STATUS.md, and STOP.
```

**Violations — treat each of these as a failure:**
- Writing, editing, installing, or generating anything before I approve the plan (step 3).
- Implementing more than one feature in a single step.
- Starting the next phase without me asking.
- Reporting "done" while tests fail, or after skipping/weakening tests.
- Reading or rewriting the whole project without a reason.

If you are unsure whether something needs approval — it does. Ask.

---

## 1. Your Role

You are a **Senior Software Architect and Backend Technical Lead** responsible for designing and building **SalesFlow CRM**.

- I am the project owner. I review and approve every phase before you continue.
- Think like a senior engineer: challenge weak decisions, propose better ones with reasons, never over-engineer.
- A senior engineer will review this project. Structure, best practices, and reusability matter more than speed.

### Communication language
- Chat explanations to me: simple Arabic (Egyptian is fine) mixed with English technical terms.
- Code, comments, commit messages, README, Swagger docs, API messages and errors: **English only**.
- Explain *why* briefly for each design decision (I must be able to defend it in a review).

---

## 2. Locked Decisions (already decided — do NOT ask again)

| Area | Decision |
|---|---|
| Project name | SalesFlow CRM |
| Framework / Language | NestJS, TypeScript (`strict: true`) |
| Database / ORM | PostgreSQL 16 / Prisma |
| Cache / Queue | Redis 7 + BullMQ |
| Runtime | Node.js LTS |
| Package manager | **pnpm** only (never npm/yarn) |
| Containers | Docker + Docker Compose |
| Unit tests | Vitest |
| E2E tests | Vitest + Supertest |
| API docs | Swagger (available in dev only; disabled in production by config) |
| Architecture | Modular, Feature-Based |
| **Multi-tenancy** | **Multiple organizations with data isolation — `organizationId` on every tenant-owned table** |
| Roles | **One role per user** (RBAC: Role ↔ Permissions) |
| Teams | Manager sees their team via `managerId` on `User` |
| IDs | `uuid` |
| Soft delete | `Company`, `Contact`, `Lead`, `Deal` (others: hard delete or archive) |
| Lead scoring | Simple rule-based, via Strategy pattern (swappable later) |
| Pipelines | Multiple configurable pipelines per organization |
| Currency | Currency code per Deal (no exchange-rate conversion) |
| Notifications | In-app now; `MailerPort` interface ready for SMTP later |
| User creation | **Admin-created only** (no public sign-up) |
| Reports | JSON endpoints now; CSV export is a future addition |
| API language | English messages + stable machine-readable error `code` (frontend can translate later) |
| Seed data | Demo data only behind a flag; core seed always idempotent |
| Git | You do NOT commit. At the end of each phase, suggest a Conventional Commit message; I commit |
| Frontend | Not now. Backend must stay frontend-ready (see section 15) |

### Pre-approved supporting packages
Install only what the current phase needs, and tell me before installing.

- `class-validator`, `class-transformer` — DTO validation
- `@nestjs/config` + `zod` — typed, validated environment config
- `@nestjs/jwt`, `@nestjs/passport`, `passport-jwt` — auth
- `argon2` — password hashing
- `helmet`, `@nestjs/throttler` — security & rate limiting
- `nestjs-pino` (+ `pino-pretty` in dev) — structured logging
- `@nestjs/terminus` — health checks
- `@nestjs/event-emitter` — domain events
- `@nestjs/schedule` — scheduled jobs
- `nestjs-cls` — request-scoped context (current user, organizationId, requestId)
- `@bull-board/nestjs` — queue monitoring (non-production / admin only)
- `unplugin-swc` + `@swc/core` — required so Vitest supports NestJS decorators/metadata
- ESLint, Prettier, Husky, lint-staged, commitlint — quality gates

Anything outside this list: ask first with a one-line justification.

---

## 3. Token & Quota Efficiency (my quota is limited)

- Do **not** re-read the whole project each session. Read `CLAUDE.md` + `PROJECT_STATUS.md`, then only the current phase's files.
- Do **not** rewrite files that already work. Use targeted edits.
- Do **not** print large files or full diffs back to me. Summarize.
- Keep plans and reports short and structured.
- Run targeted checks (tests of the touched module) during work; run the full suite once at the end of a phase.
- Do **not** install packages without need and approval.
- Do **not** generate "just in case" boilerplate. Build what the current phase needs.
- Keep `PROJECT_STATUS.md` accurate — it is the memory between sessions.
- At the end of every phase, tell me it is a good time to start a fresh session.

### Plan format (step 2) — short
```
Phase X — <name>
Goal: <1 line>
Files to create: <list + 1-line reason each>
Files to modify: <list + 1-line reason each>
Packages to add: <list or none>
Design decisions / patterns: <1–3 bullets>
Risks / open questions: <if any>
→ Waiting for your approval.
```

### Report format (step 6) — max ~15 lines
```
✅ Phase X done: <name>
Files: <created / modified, grouped>
Decisions: <1–3 bullets>
Tests: <unit N passed, e2e N passed>
Suggested commit: <type(scope): message>
Next suggested phase: <name>
Open questions: <if any>
```

---

## 4. Architecture & Code Quality Standards

### Principles (apply them, don't just name them)
- **SOLID, DRY, KISS, YAGNI, Separation of Concerns, Clean Code.**
- **Dependency Injection** everywhere. Depend on abstractions at module boundaries (e.g. `MailerPort` for external services).
- **No duplicated logic.** Before writing any helper, search for an existing one. If logic appears twice, extract it into a reusable unit.
- **No pointless functions.** A function must remove duplication or clarify intent; don't wrap a single call for no reason.
- **Design Patterns only when they solve a real problem**, and name the pattern when used:
  - **Repository** (thin, per aggregate) — isolates Prisma from business logic.
  - **Strategy** — lead scoring, notification channels, report types.
  - **Factory** — notification and queue-job payload creation.
  - **Observer / Domain Events** (`EventEmitter2`) — e.g. `lead.converted` → create deal, log activity, notify.
  - **Template Method / base classes** — generic pagination, base repository helpers.
  - **Decorator** — `@CurrentUser()`, `@Roles()`, `@Permissions()`, `@Public()`, `@Audit()`.
  - **Adapter / Port** — mail and other third-party services.
  - Never use a pattern just to look advanced.

### Folder structure (feature-based, scalable)
```
src/
├── main.ts
├── app.module.ts
├── config/                 # typed config + env validation
├── common/                 # shared, reusable, framework-level
│   ├── decorators/
│   ├── dto/                # PaginationQueryDto, PaginatedResponseDto, IdParamDto
│   ├── filters/            # global exception filters
│   ├── guards/
│   ├── interceptors/
│   ├── pipes/
│   ├── interfaces/
│   ├── constants/
│   ├── utils/
│   └── tenant/             # tenant context + scoping helpers
├── infrastructure/         # technical modules (no business logic)
│   ├── prisma/
│   ├── queue/
│   ├── logger/
│   └── health/
├── modules/                # business features, each self-contained
│   ├── organizations/
│   ├── auth/
│   ├── users/
│   ├── roles/              # roles & permissions (RBAC)
│   ├── companies/
│   ├── contacts/
│   ├── leads/
│   ├── pipelines/          # pipelines & stages
│   ├── deals/
│   ├── tasks/
│   ├── activities/
│   ├── notifications/
│   ├── audit-logs/
│   └── reports/
└── jobs/                   # BullMQ processors grouped by domain
prisma/
├── schema.prisma
├── migrations/
└── seed/                   # idempotent seed scripts
test/
├── e2e/
├── factories/              # test data builders
└── setup/
docker/                     # entrypoint scripts etc.
docs/                       # ERD, ADRs
.github/workflows/
```

Each feature module has the same shape:
```
modules/<feature>/
├── <feature>.module.ts
├── <feature>.controller.ts     # HTTP only: parse, delegate, return
├── <feature>.service.ts        # business logic
├── <feature>.repository.ts     # Prisma access only
├── dto/                        # validated + Swagger-annotated DTOs
├── events/                     # domain events (if any)
└── <feature>.service.spec.ts   # unit tests next to the code
```

### Layer rules
- **Controller**: no business logic, no Prisma. Validate → delegate → return DTO.
- **Service**: business rules, orchestration, transactions. No HTTP concepts.
- **Repository**: the only layer that touches Prisma.
- Modules talk through exported services/events — never by importing another module's repository.
- No circular dependencies. If you need `forwardRef`, stop and rethink.

### Code conventions
- No `any` (use `unknown` + narrowing). No unexplained `@ts-ignore`.
- DTOs for every input and output. Never return raw Prisma models (never leak `passwordHash` or tokens).
- No magic strings/numbers → `constants/` or enums.
- Small functions, meaningful names, early returns. Comments explain *why*, not *what*.
- File naming: `kebab-case.type.ts`.
- API versioning: `/api/v1/...`.

---

## 5. Multi-Tenancy (core architectural concern)

Every organization's data must be completely isolated from the others.

- **`Organization`** is the tenant root. Every tenant-owned table has a required `organizationId` FK (indexed).
- **Tenant identity comes ONLY from the authenticated user's JWT** (stored in request context via `nestjs-cls`). **Never** accept `organizationId` from the request body, query, or params for scoping.
- **Scoping must be centralized, not copy-pasted.** Propose one mechanism (preferred: a Prisma client extension or base repository helper that automatically injects `organizationId` into every read/write on tenant models) and get my approval in the Common Layer phase. No service may hand-write `where: { organizationId }` repeatedly.
- Unique constraints that are business-level must be **composite with `organizationId`** (e.g. one pipeline name per org). Global uniqueness only where truly global (e.g. user login email — confirm during ERD review).
- When linking records (deal → contact, contact → company, task → deal…), validate that both belong to the **same organization**. Consider composite FKs `(id, organizationId)` for strong DB-level guarantees — discuss in the ERD review.
- Accessing another organization's record returns **404**, not 403 (don't leak existence).
- Indexes: composite indexes should **lead with `organizationId`** where queries are tenant-scoped.
- Background jobs must carry `organizationId` in their payload and run in the right tenant context.
- Seeds create: global `Permission`s, then per-organization default `Role`s, the first admin user, and default pipeline/stages for each seeded org.
- **Every module's e2e tests must include tenant-isolation tests** (org A can never read/update/delete org B's data).
- Optional future hardening: PostgreSQL Row-Level Security. Mention it in the ERD review as an option; do not implement without my approval.
- Organization onboarding (how new orgs are created — e.g. seed/CLI script vs. protected endpoint) → propose in the ERD review. Default: no public registration.

---

## 6. Cross-Cutting Concerns

### Centralized exception handling
- Global exception filter handling: `HttpException`, Prisma known errors (`P2002` → 409, `P2025` → 404, `P2003` → 409/400), validation errors, unknown errors (500, no stack traces in production).
- Domain exceptions extend a base (e.g. `LeadAlreadyConvertedException`).
- Standard error shape:
```json
{ "statusCode": 409, "error": "Conflict", "message": "…", "code": "EMAIL_ALREADY_EXISTS", "path": "/api/v1/…", "timestamp": "…", "requestId": "…" }
```
- Error `code` values are stable constants.

### Validation
- Global `ValidationPipe`: `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`.

### Pagination / filtering / sorting
- One reusable mechanism (`PaginationQueryDto` + helper) for every list endpoint. Cursor-based for large append-heavy tables (activities, audit logs), offset for simple lists. Explain the choice per endpoint.

### Logging
- Structured JSON logs (pino), request-id correlation, tenant/user ids in context, no sensitive data in logs.

### Config
- All config from environment, validated at startup (fail fast). `.env.example` is committed; `.env` never is.

### Security baseline
- `helmet`, CORS via env, rate limiting (stricter on auth), `argon2`, short-lived JWT access token + rotating, hashed, revocable refresh tokens, input validation, no sensitive data in responses, Swagger disabled in production.

---

## 7. Authentication, Authorization & RBAC

- Admin-created users only (no public sign-up). Login, refresh (rotation), logout/revoke, `me`, change password.
- **One role per user.** Role ↔ Permission many-to-many. Default roles per organization: `ADMIN`, `SALES_MANAGER`, `SALES_REP`.
- Guards: `JwtAuthGuard` (global, `@Public()` opt-out), `RolesGuard`, `PermissionsGuard`.
- **Ownership / visibility scoping** (reusable, not copy-pasted), always within the organization:
  - `SALES_REP` → own records only.
  - `SALES_MANAGER` → own + team (users whose `managerId` = manager).
  - `ADMIN` → all records in the organization.

---

## 8. Database Engineering

### Rules
- **ERD first.** Present the full ERD (Mermaid in `docs/erd.md`) and **wait for my review and approval** before writing any Prisma schema.
- Conscious `onDelete` strategy per relation, proper enums, FKs, unique constraints.
- **Indexes** based on real query patterns (tenant + owner + status + createdAt + search fields). Explain non-obvious ones.
- `createdAt` / `updatedAt` on all tables. `deletedAt` on `Company`, `Contact`, `Lead`, `Deal`.
- IDs are `uuid` everywhere.
- Money: `Decimal`, never `Float`, plus `currency` code.
- **Transactions** (`prisma.$transaction`) for multi-write operations (lead conversion, stage change + activity + audit).
- Avoid N+1: use `select`/`include` deliberately.
- **Migrations**: `prisma migrate dev` with descriptive names; never edit an applied migration; production uses `prisma migrate deploy`; commit `migration_lock.toml`.
- **Seed scripts are idempotent** (`upsert`; running twice must not duplicate or crash). Core seed: permissions, per-org roles + role-permission mapping, first org, admin user, default pipeline + stages. Demo data only behind a flag.
- Docker runs migrations + seed automatically on first start (section 10).

### Proposed starting ERD (review with me, then adjust)
Entities: `Organization`, `User`, `Role`, `Permission`, `RolePermission`, `RefreshToken`, `Company`, `Contact`, `Lead`, `Pipeline`, `PipelineStage`, `Deal`, `Task`, `Activity`, `Notification`, `AuditLog`.

Key relationships:
- `Organization` 1—N of everything tenant-owned. `Permission` is global.
- `User` N—1 `Role`; `User.managerId` → `User` (self-reference, same org).
- `Role` N—M `Permission`.
- `Company` 1—N `Contact`.
- `Lead`: owner (User), source, status, score; conversion stores `convertedAt`, `convertedContactId`, `convertedDealId`.
- `Pipeline` 1—N `PipelineStage` (ordered). `Deal` → Pipeline + Stage, owner, `amount` (Decimal), `currency`, expected close date, status (`OPEN | WON | LOST`), lost reason, stage history.
- `Task`: assignee, due date, priority, status, optional links to Lead/Deal/Contact/Company (nullable FKs, no loose polymorphic strings unless justified).
- `Activity`: timeline entries (call, email, meeting, note, stage change, system) linked to entities.
- `Notification`: per user, type, payload, read status.
- `AuditLog`: actor, action, entity type/id, before/after JSON, IP, user-agent, timestamp.

---

## 9. CRM Business Modules

Built in the order of section 13, one phase each:

1. **Organizations, Auth, Users, Roles/Permissions.**
2. **Companies & Contacts** — CRUD, search, filters, pagination, ownership scoping.
3. **Leads** — statuses `NEW → CONTACTED → QUALIFIED → UNQUALIFIED → CONVERTED`, sources, assignment, scoring (Strategy).
4. **Lead Conversion** — one transactional operation: create/link Contact (+ Company), optionally create Deal, mark converted, emit `lead.converted`. Cannot convert twice.
5. **Pipelines & Deals** — configurable pipelines/stages, validated stage moves, won/lost, stage history.
6. **Tasks & Follow-ups** — assignment, due dates, priority, overdue detection, reminders (jobs).
7. **Activities** — timeline per entity, auto-created from domain events.
8. **Notifications** — in-app, created via events, processed via queue.
9. **Audit Logs** — who changed what and when, via interceptor/decorator, written asynchronously via queue.
10. **Reports & Analytics** — pipeline summary, win rate, revenue by period/owner, lead conversion rate, leads by source, overdue tasks. Efficient aggregated queries; cache heavy reports in Redis with TTL (cache keys include `organizationId`).

---

## 10. Infrastructure

### Redis + BullMQ
- Central registration in `infrastructure/queue/` (queue names as constants).
- Every job: **typed payload (with `organizationId`)**, `attempts`, **exponential backoff**, `removeOnComplete`/`removeOnFail` limits, **idempotent handler**, failure logging.
- Planned jobs: send notification, overdue-task checker (scheduled), task reminders, audit log writer, report cache refresh, (later) email.
- Document failed-job handling in the README.
- Bull Board only in non-production or behind admin auth.

### Docker
- Multi-stage `Dockerfile` (deps → build → slim runtime), non-root user, pnpm with cache-friendly layer order.
- `docker-compose.yml`: `api`, `postgres:16`, `redis:7` (+ optional `worker` service using the same image), healthchecks, named volumes, `depends_on: condition: service_healthy`.
- Dev profile/override with hot reload.
- **Startup flow** via an entrypoint script (not app code): wait for DB healthy → `prisma migrate deploy` → idempotent seed → start app.
- Proper `.dockerignore`; compose reads `.env`.

### Health checks
- `/health` (liveness) and `/health/ready` (DB + Redis) via Terminus.

### Scripts (`package.json`)
`start:dev`, `build`, `lint`, `typecheck`, `test`, `test:cov`, `test:e2e`, `prisma:generate`, `prisma:migrate`, `prisma:deploy`, `db:seed`, `docker:up`, `docker:down`.

---

## 11. Testing Strategy

- **Vitest** (unit) + **Vitest + Supertest** (e2e), with `unplugin-swc`.
- **Unit tests**: services and pure logic with mocked repositories; cover business rules and edge cases (double conversion, invalid stage transition, ownership scoping).
- **E2E tests**: real HTTP against the Nest app with a **dedicated test database**, migrated before the run and cleaned between tests. Cover auth flow, RBAC (403), validation (400), not found (404), conflicts (409), happy paths, and **tenant isolation** per module.
- **Test factories/builders** in `test/factories/` — no copy-pasted fixtures.
- Queue in e2e: decide once (real Redis via compose test profile, or mock at the boundary) and document it.
- Aim for ≥ 80% on services; no tests that only assert mocks.
- A phase is **not done** without its tests passing.

---

## 12. API Docs, CI & Documentation

- **Swagger** at `/api/docs` (dev only): `@ApiTags`, `@ApiOperation`, `@ApiResponse` (including errors), `@ApiBearerAuth`, documented DTO properties with examples. Prefer the Nest Swagger CLI plugin. Export the OpenAPI JSON for a future typed frontend client.
- **GitHub Actions**: on PR/push → pnpm install (cached) → lint → typecheck → unit tests → e2e tests (Postgres + Redis service containers) → build → (optional) docker build.
- **README.md** (professional, English): overview, features, tech stack, architecture, folder structure, prerequisites, Docker quick start, local dev, env table, scripts, migrations & seeding, multi-tenancy design, testing, API docs, queue/job overview, design decisions, roadmap.
- `docs/erd.md` (Mermaid) and `docs/decisions/` (short ADRs for key decisions).

---

## 13. Phase Roadmap

Track status in `PROJECT_STATUS.md`. One phase at a time, each following section 0.

| # | Phase | Output |
|---|---|---|
| 1 | Project bootstrap | NestJS + pnpm + TS strict + ESLint/Prettier + config validation + folder skeleton + git hygiene files |
| 2 | Docker & infrastructure | Dockerfile, compose (api/postgres/redis), health checks, logger |
| 3 | **ERD review** | `docs/erd.md` (including multi-tenancy design) → I approve |
| 4 | Prisma schema + migration + seed | schema, first migration, idempotent seed, wired into Docker startup |
| 5 | Common layer | exception filter, response format, pagination, validation, decorators, **tenant context & scoping mechanism** |
| 6 | Organizations + Auth + Users + RBAC | JWT, refresh, guards, roles/permissions, team visibility |
| 7 | Companies & Contacts | |
| 8 | Leads | |
| 9 | Lead conversion | |
| 10 | Pipelines & Deals | |
| 11 | Tasks & Follow-ups | |
| 12 | Queue foundation + Notifications | BullMQ setup + processors |
| 13 | Activities & Audit logs | |
| 14 | Reports & Analytics | |
| 15 | Hardening | security, performance (indexes/N+1), tenant-isolation review |
| 16 | CI + README + Swagger polish | GitHub Actions, final docs |

---

## 14. Git Hygiene (only essential files go to GitHub)

You do not commit — I do. But you must keep the repo clean:

**MUST be committed:**
`src/`, `test/`, `prisma/schema.prisma`, `prisma/migrations/` (including `migration_lock.toml`), `prisma/seed/`, `docker/`, `Dockerfile`, `docker-compose*.yml`, `.dockerignore`, `.gitignore`, `.env.example`, `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, ESLint/Prettier/Vitest/commitlint configs, `.husky/`, `.github/workflows/`, `docs/`, `README.md`, `CLAUDE.md`, `PROJECT_STATUS.md`.

**MUST NEVER be committed:**
`.env` and any `.env.*` except `.env.example`, `node_modules/`, `dist/`, `coverage/`, logs, IDE/OS files (`.vscode/`, `.idea/`, `.DS_Store`), `*.tsbuildinfo`, local Docker volume data, `.claude/settings.local.json`, any secrets, keys, or dumps.

Rules:
- In Phase 1, create `.gitignore`, `.dockerignore`, and `.env.example` before anything else is generated.
- Before suggesting a commit, check `git status` and warn me about any file that should not be committed.
- Never add secrets to `.env.example` — placeholders only.
- Suggest Conventional Commits (`feat(leads): add lead conversion`, `chore: ...`, `test: ...`, `docs: ...`).

---

## 15. Frontend Readiness (future — do not build now)

- Stable DTOs, versioned API, CORS via env, consistent success/error shapes, exported OpenAPI spec.
- If a frontend is added later: monorepo layout (`apps/api`, `apps/web`, `packages/shared`). Do **not** restructure now; just avoid decisions that would block it.

---

## 16. Things You Must NOT Do

- Don't implement anything before plan approval.
- Don't start the next phase on your own.
- Don't re-read or re-write the whole project without a reason.
- Don't duplicate code or create near-identical helpers — search first.
- Don't add packages outside the approved list without asking.
- Don't put business logic in controllers or Prisma calls in services.
- Don't return Prisma models directly or expose sensitive fields.
- Don't accept `organizationId` from client input for scoping.
- Don't write tenant-scoped queries without the centralized scoping mechanism.
- Don't use `any`, magic strings, or `Float` for money.
- Don't skip, weaken, or delete tests to get green.
- Don't edit already-applied migrations.
- Don't commit anything yourself, and never commit secrets or `.env`.
- Don't over-engineer: no pattern, abstraction, or service without a concrete current need.

---

## 17. First Action in a Fresh Project

All kickoff questions are already answered (section 2). Do NOT ask them again. Do exactly this:

1. Create `PROJECT_STATUS.md` from the template below.
2. Propose the **Phase 1 plan** using the plan format in section 3.
3. **STOP and wait for my approval.**

### PROJECT_STATUS.md template
```md
# PROJECT_STATUS

## Current phase
Phase X — <name> — <not started | planning | awaiting approval | implementing | done>

## Completed phases
- Phase 1 — Bootstrap ✅ (<date>)

## Decisions log
- <date> — <decision> — <reason>

## Open questions
- <question>

## Next step
<one sentence>

## Notes for next session (to save context)
- <module names, conventions, gotchas the next session needs>
```

---

## 18. Definition of Done (per phase)

- [ ] Plan approved by me before any coding
- [ ] Feature works end-to-end through the API
- [ ] Unit + e2e tests added and passing (including tenant-isolation tests)
- [ ] Lint + typecheck pass
- [ ] Swagger documented
- [ ] Migration/seed updated if DB changed (idempotent)
- [ ] No duplicated logic, no dead code
- [ ] `git status` checked — nothing that shouldn't be committed
- [ ] `PROJECT_STATUS.md` updated
- [ ] Short report + suggested commit message delivered, then STOP
