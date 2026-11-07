// Access tokens are HS256 JWTs; the algorithm is pinned on both sign and verify so a token with a
// different `alg` (including `none`) can never be accepted.
export const JWT_ALGORITHM = 'HS256';
export const JWT_ISSUER = 'salesflow-api';
export const JWT_AUDIENCE = 'salesflow-clients';

export const REFRESH_TOKEN_BYTES = 32;
export const TOKEN_TYPE = 'Bearer';

// Clean-up of refresh tokens runs daily per organization. A token is removed only once it expired
// this long ago (so anything still inside the reuse-detection window or a support investigation is
// untouched), and never while its family still has a live token. Change the number here.
export const REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_DAYS = 7;
export const REFRESH_TOKEN_CLEANUP_BATCH_SIZE = 1000;
export const REFRESH_TOKEN_CLEANUP_MAX_BATCHES = 50;
