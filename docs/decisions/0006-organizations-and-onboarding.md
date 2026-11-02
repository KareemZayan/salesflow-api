# ADR 0006 — Organization settings and onboarding (Phase 6d)

Status: accepted

## Settings API

`GET /organizations/current` (any authenticated user) and `PATCH /organizations/current`
(`organizations:update`, granted to ADMIN by the seed). There is no `:id`: the caller's organization
comes from the JWT, so there is nothing to aim at another tenant. `Organization` is the tenant root
and is not filtered by the scoping extension, so the repository keys every query by the caller's id.

- Editable: `name` (trimmed, max 100) and `defaultCurrency` (ISO 4217, uppercased).
- Not editable through the API: `slug` (the natural key used by the CLI and the seed) and `isActive`
  (an organization must not be able to deactivate itself, and could not reactivate itself). Unknown
  fields are 400; an empty body is 400; `null` is 400 (`OptionalButNotNull`).
- `GET` is not exempt from the forced password change: it answers `403 PASSWORD_CHANGE_REQUIRED`
  like every other route except `me` and `change-password`.

## Shared policy files (`src/common/policies/`)

Password rules, the ISO 4217 check and the organization name/slug rules live in self-contained files
(no imports). The API, the seed and the CLI all use them, so there is one definition of each rule:

- Password: 10–128 characters plus a blocklist (the `.env.example` placeholder). `PasswordService`
  enforces both. The seed enforces the length rule always and the blocklist in production only (the
  committed `.env.example` must keep working in development). The CLI enforces both.
- Currency: `isCurrencyCode` (uppercase, known to ICU via `Intl.supportedValuesOf`), wrapped by the
  `@IsCurrencyCode()` validator in `common/validators/`, which Phase 10 (Deals) reuses.

They are self-contained because the seed and CLI run from the runtime image, which contains
`src/common/policies` and `src/generated` but not the rest of `src/`.

## `org:create` (operator CLI)

```
pnpm org:create --name "Acme" --slug acme --admin-email boss@acme.com \
  [--admin-first-name Sara] [--admin-last-name Ali] [--currency EUR]
```

It calls the same `seedOrganization` as the core seed: one transaction creates the organization,
the three default roles with their permissions, the first ADMIN and the default pipeline, so a
failure leaves nothing behind. The admin gets `mustChangePassword = true`.

- **Idempotent on the slug.** Same slug and the requested email is that organization's ADMIN →
  "already exists", nothing changes, no password is printed, exit 0. Existing slug with another
  admin, or an email that belongs to another organization → exit 1 (adding users is the Users API's
  job; silently succeeding would hide a mistake).
- **Concurrent runs.** A unique-constraint race (`P2002`) on the slug or email re-checks the same
  rule: it is "exists" only if the winner is the requested ADMIN, otherwise exit 1.
- **Password.** Generated (24 characters, 144 bits) and printed once to **stdout**. `ORG_ADMIN_PASSWORD`
  in the environment overrides it (validated by the shared policy, never printed or echoed). There is
  deliberately no password argument: it would land in shell history and `ps`.
- **Do not run it where stdout is shipped to shared logs** (CI logs, log aggregation). The password is
  written with `process.stdout.write`, not through the pino logger, so it never reaches structured
  logs, but anything capturing stdout will see it. Run it in an interactive shell, or capture stdout
  yourself into a secret manager.
- **Optional first/last name** default to `Admin` / `User`.

### Running it in Docker

The runtime image runs the seed with `tsx` (`docker/entrypoint.sh`: `./node_modules/.bin/tsx
prisma/seed/index.ts`; `tsx` is a production dependency, a Phase 4 decision) and has no pnpm. The CLI
runs the same way, with nothing added to the image:

```
docker compose exec api ./node_modules/.bin/tsx prisma/seed/create-org.ts \
  --name "Acme" --slug acme --admin-email boss@acme.com
```

Use `docker compose exec` (an interactive shell), not a CI step, for the stdout reason above.

## Deferred

- Organization deactivate/reactivate: the JWT strategy already honors `Organization.isActive`, but
  nothing can toggle it except SQL. Planned as an `org:set-active` CLI in Phase 15 (Hardening).
