// The inbox is always newest first; the only sortable field is the one the unread-inbox index
// (userId, readAt, createdAt desc) serves.
export const NOTIFICATION_SORT_FIELDS = ['createdAt'] as const;

// Retention is a PERMANENT delete, run daily per organization. Read ones go first; unread ones are
// kept twice as long because the user has not seen them yet. Age counts from `createdAt`. Change
// the numbers here; nothing else depends on them.
export const NOTIFICATION_RETENTION_DAYS = { read: 90, unread: 180 } as const;

// Rows removed per statement and per job run, so one big organization neither holds a long lock nor
// hogs a worker; whatever is left is taken by the next daily run.
export const NOTIFICATION_RETENTION_BATCH_SIZE = 1000;
export const NOTIFICATION_RETENTION_MAX_BATCHES = 50;
