// Access tokens are HS256 JWTs; the algorithm is pinned on both sign and verify so a token with a
// different `alg` (including `none`) can never be accepted.
export const JWT_ALGORITHM = 'HS256';
export const JWT_ISSUER = 'salesflow-api';
export const JWT_AUDIENCE = 'salesflow-clients';

export const REFRESH_TOKEN_BYTES = 32;
export const TOKEN_TYPE = 'Bearer';
