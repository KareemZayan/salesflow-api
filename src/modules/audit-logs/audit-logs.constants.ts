// Retention is a PERMANENT delete, run daily per organization, counted from `createdAt`. 730 days
// (two years) is a conservative default. The right period is a legal / contractual decision for the
// project owner to confirm before production (PROJECT_STATUS.md, open items); change the number
// here, nothing else depends on it.
export const AUDIT_RETENTION_DAYS = 730;

// Rows removed per statement and per job run. All batches of one run share ONE transaction (the
// retention flag lives and dies with it), so the cap also bounds how long that transaction is open;
// whatever is left is taken by the next daily run.
export const AUDIT_RETENTION_BATCH_SIZE = 1000;
export const AUDIT_RETENTION_MAX_BATCHES = 50;
export const AUDIT_RETENTION_TX_TIMEOUT_MS = 120_000;
