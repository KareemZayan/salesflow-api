export const USER_SORT_FIELDS = ['firstName', 'lastName', 'email', 'createdAt'] as const;
export const NAME_MAX_LENGTH = 100;
export const EMAIL_MAX_LENGTH = 254;
export const SEARCH_MAX_LENGTH = 100;
// Stops a malformed manager chain (should not exist) from looping forever.
export const MAX_MANAGER_DEPTH = 100;
