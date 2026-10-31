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

| Script           | Description              |
| ---------------- | ------------------------ |
| `pnpm start:dev` | Run in watch mode        |
| `pnpm build`     | Compile to `dist/`       |
| `pnpm lint`      | ESLint                   |
| `pnpm typecheck` | TypeScript type check    |
| `pnpm test`      | Unit tests (Vitest)      |
| `pnpm test:cov`  | Unit tests with coverage |

## Authentication

Users are created by an admin (no public sign-up). `POST /api/v1/auth/login` returns a 15-minute access token (`Authorization: Bearer ...`) and an opaque, single-use refresh token (in the JSON body). Design and rationale: [ADR 0003](docs/decisions/0003-authentication.md).

- **Refresh**: `POST /auth/refresh` rotates the refresh token. Sending an already-used token again within `REFRESH_REUSE_GRACE_SECONDS` (default 10) answers **409 `TOKEN_ROTATED_RECENTLY`**: the session is still valid, so do **not** log the user out; retry with the token from the latest successful response. Replaying a token after that window answers 401 `TOKEN_REUSED` and revokes the whole session.
- **Logout**: `POST /auth/logout` with the refresh token in the body; always 204.
- **Change password**: revokes all refresh tokens and returns a new pair. Access tokens issued earlier stay valid until they expire.
- **Rate limiting**: login is limited per IP + email (`THROTTLE_AUTH_LIMIT` per `THROTTLE_TTL_SECONDS`). Counters are in memory (per instance, reset on restart); move them to Redis before scaling out.

### Behind a reverse proxy (`TRUST_PROXY`)

The rate limiter keys on the client IP. Behind nginx, a cloud load balancer or similar, every request appears to come from the proxy unless Express is told to trust it, and all clients then share one rate-limit bucket.

| Setup                                                                   | `TRUST_PROXY`                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| API reachable directly (default, local dev, the bundled Docker Compose) | `false`                                                    |
| One reverse proxy / load balancer in front                              | `1`                                                        |
| Several hops, or a known proxy network                                  | hop count, or a subnet list such as `loopback, 10.0.0.0/8` |

Never set `true` while the API is directly reachable: any client could then spoof `X-Forwarded-For` to dodge the limit.
