// The inbox is always newest first; the only sortable field is the one the unread-inbox index
// (userId, readAt, createdAt desc) serves.
export const NOTIFICATION_SORT_FIELDS = ['createdAt'] as const;
