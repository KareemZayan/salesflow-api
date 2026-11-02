export const LEAD_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'score',
  'lastName',
  'firstName',
] as const;
// Free-text columns the `q` search looks at.
export const LEAD_SEARCH_FIELDS = ['firstName', 'lastName', 'email', 'companyName'] as const;

export const LEAD_NAME_MAX_LENGTH = 100;
// RFC 5321 limit for an address.
export const LEAD_EMAIL_MAX_LENGTH = 254;
export const LEAD_COMPANY_NAME_MAX_LENGTH = 200;
export const LEAD_NOTES_MAX_LENGTH = 5000;
