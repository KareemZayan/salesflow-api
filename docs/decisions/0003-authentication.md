# ADR 0003 — Authentication: short-lived JWT access tokens, opaque rotating refresh tokens

- Status: accepted (Phase 6a, 2026-10-31)

## Decision

**Access token** — HS256 JWT, 15 minutes (`JWT_ACCESS_EXPIRES_IN`), claims `sub` (user id) and `org` (organization id), plus `iss`/`aud`. The algorithm list is pinned to `['HS256']` on verify, so `alg: none` and other algorithms are rejected. Role and permissions are **not** in the token: `JwtStrategy.validate` loads user, role, permissions and organization status in one query on every request. Deactivating a user or organization, or changing a role or its permissions, therefore applies to still-valid tokens immediately. The `org` claim must equal the user's real organization. The tenant enters the request context from the verified user (`JwtAuthGuard` calls `TenantContextService.setUser`), never from request input.

**Refresh token** — 256 random bits (base64url), opaque, no secret needed (hence no `JWT_REFRESH_SECRET`). Only its SHA-256 is stored. Single use: every refresh rotates it inside the same `familyId`. Lifetime `JWT_REFRESH_EXPIRES_IN` (7d).

**Transport** — both tokens travel in the JSON body (`refreshToken` in the request body of refresh/logout). This keeps the API trivially usable from any client and from tests.
_Revisit when a browser frontend is added:_ an `httpOnly; Secure; SameSite` cookie for the refresh token keeps it out of reach of XSS, at the price of CORS-with-credentials configuration and CSRF protection on refresh/logout. Switching changes only the controller and the DTOs.

## Rotation, reuse detection, and the grace window

Rotation is atomic: inside one transaction, `updateMany({ where: { id, revokedAt: null, expiresAt > now } })` revokes the presented token, and the successor is created only if `count === 1`. Of N concurrent requests with the same token exactly one wins.

A revoked token that shows up again is classified by _when_ it was revoked:

| Situation                                                                                    | Answer                           | Effect                      |
| -------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------- |
| Revoked less than `REFRESH_REUSE_GRACE_SECONDS` (10) ago **and the family has a live token** | **409** `TOKEN_ROTATED_RECENTLY` | Nothing is revoked          |
| Revoked less than the grace window ago, family already dead (logout, burn, new password)     | 401 `INVALID_REFRESH_TOKEN`      | Nothing                     |
| Revoked longer ago                                                                           | 401 `TOKEN_REUSED`               | The whole family is revoked |

Why a grace window: a client that fires two refreshes at once (two tabs, a retry after a lost response) must not be treated as an attacker. Why **409 and not 401**: 401 means "your session is over" and clients log the user out; here the session is fine and the client should retry with the token it already received in the winning response. The losing request cannot be handed the successor, because the raw token is never stored.

Other refresh rules: an inactive user or organization revokes the family and answers 401. Logout takes the refresh token in the body, revokes its whole family and is idempotent (204 even for an unknown token, so it cannot be used to probe tokens).

## Passwords

argon2id with library defaults (the seed hashes the same way). Policy: 10–128 characters and not the seed placeholder, enforced in `PasswordService`. Login with an unknown email verifies against a dummy hash created once at startup with the same parameters, so response time does not reveal whether an account exists. Wrong password, unknown email, inactive user and inactive organization all return the same `INVALID_CREDENTIALS`.

`change-password` verifies the current password, rejects a new password equal to it, revokes **all** refresh tokens of the user and returns a new token pair in a new family. **Access tokens issued earlier stay valid until they expire** (at most 15 minutes): they are stateless and only refresh tokens can be revoked.

`User.mustChangePassword` (set by admin-created accounts and admin password resets, cleared by `change-password`) locks every route except `me` and `change-password` with 403 `PASSWORD_CHANGE_REQUIRED` (`PasswordChangeRequiredGuard`).

## Rate limiting

Global default (`THROTTLE_LIMIT` per `THROTTLE_TTL_SECONDS`), plus a stricter `auth` throttler (`THROTTLE_AUTH_LIMIT`) on login, refresh, logout and change-password. It tracks **IP + normalized email**, so one IP cannot spray many accounts cheaply and an attacker cannot lock a victim out from every other IP. Counters are in memory: they reset on restart and are per instance. Use a Redis storage before running several instances. The `X-Forwarded-For` chain is only honoured when `TRUST_PROXY` is set (see README); otherwise everyone behind a proxy shares one bucket.

## Known limits

- Expired and revoked refresh tokens accumulate; the cleanup job arrives with the queue foundation (Phase 12).
- One extra query per authenticated request. A short-TTL cache can be added in Phase 15 if profiling shows a need.
