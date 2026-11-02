export const ROLE_SORT_FIELDS = ['name', 'createdAt'] as const;
export const ROLE_NAME_MAX_LENGTH = 50;
export const ROLE_DESCRIPTION_MAX_LENGTH = 255;
// Well above the size of the catalogue; it only exists to bound the request.
export const MAX_PERMISSION_KEYS = 100;
export const PERMISSION_KEY_MAX_LENGTH = 100;
