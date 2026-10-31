// Access tokens are HS256 JWTs; the algorithm is pinned on both sign and verify so a token with a
// different `alg` (including `none`) can never be accepted.
export const JWT_ALGORITHM = 'HS256';
export const JWT_ISSUER = 'salesflow-api';
export const JWT_AUDIENCE = 'salesflow-clients';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
// The seed's placeholder admin password (prisma/seed/seed-env.ts, a separate build so not imported;
// a unit test keeps the two in sync). Nobody may use it as a real password.
export const REJECTED_PASSWORDS: ReadonlySet<string> = new Set(['change_me_strong_password']);

export const REFRESH_TOKEN_BYTES = 32;
export const TOKEN_TYPE = 'Bearer';
