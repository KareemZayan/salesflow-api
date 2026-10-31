# ADR 0002 — Tenant scoping through a Prisma client extension

- Status: accepted (Phase 5, 2026-10-31). Implements ERD section 5.3.

## Decision

Repositories inject `PRISMA_TENANT`, a Prisma client extended by `createTenantClient` (`common/tenant/`). The organization comes from `TenantContextService` (nestjs-cls), set from the JWT, or by `run(orgId, fn)` in jobs. Rules, all enforced in `scopeArgs`:

- Tenant models (everything with `organizationId`, **including `User` and `RefreshToken`**) get `organizationId` added to `where` on reads/updates/deletes and to `data` on `create`, `createMany`, `createManyAndReturn` and `upsert.create`. A caller-supplied `organizationId` is overwritten.
- `organizationId` inside `data` of `update`, `updateMany` or `upsert.update` is rejected (`TenantScopeViolationError`): records never change tenant.
- No tenant in context means the query throws (`MissingTenantContextError`). It never runs unscoped.
- An unknown operation on a tenant model throws (fail closed).
- `Company`, `Contact`, `Lead`, `Deal` also get `deletedAt: null` on every read and write. `delete`/`deleteMany` are model-level overrides that turn into an update of `deletedAt` (through the same extension, so still scoped and still inside the caller's transaction). Updating a soft-deleted row fails with `P2025`. `TenantContextService.withDeleted(fn)` is the explicit opt-out (restore, trash).
- `findUnique*` stays `findUnique`: Prisma accepts extra non-unique filters in `where`, so a foreign id is `null` / `P2025` (404) without rewriting the operation.

The unscoped client is `PrismaService`. ESLint (`no-restricted-imports`, `no-restricted-syntax`) allows it, and `$queryRaw`/`$executeRaw`, only in `src/modules/auth`, `src/modules/reports`, `src/jobs/bootstrap`, `src/infrastructure`, `prisma/seed`, and tests. Hard deletes also need it.

## Deviation from the ERD text

ERD 5.4 listed `User` and `RefreshToken` as "without automatic scoping". They are scoped now: the Users module must never filter by organization by hand. Login and refresh (before a tenant exists) use the unscoped client. `Organization`, `Permission` and `RolePermission` (no `organizationId` column) stay unscoped.

## Known limits

- Nested relation filters are not rewritten. `include` of a soft-deletable relation still returns deleted children; repositories add `where: { deletedAt: null }` there. Cross-tenant links are blocked by the composite FKs.
- A Prisma query is lazy: it runs when awaited. Always `await` it inside the tenant context (`run`/`withDeleted` do).
- Scoped `create` input types still require `organizationId` (Prisma types cannot make it optional); see PROJECT_STATUS for the open question.
- `$queryRaw` is not scoped; reports must take `organizationId` as a mandatory parameter.
