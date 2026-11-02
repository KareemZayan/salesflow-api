export const CONTACT_SORT_FIELDS = ['lastName', 'firstName', 'createdAt', 'updatedAt'] as const;
// Free-text columns the `q` search looks at.
export const CONTACT_SEARCH_FIELDS = ['firstName', 'lastName', 'email', 'jobTitle'] as const;

export const CONTACT_NAME_MAX_LENGTH = 100;
// RFC 5321 limit for an address.
export const CONTACT_EMAIL_MAX_LENGTH = 254;
export const CONTACT_JOB_TITLE_MAX_LENGTH = 100;
