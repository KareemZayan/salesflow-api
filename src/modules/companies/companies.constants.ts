export const COMPANY_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;
// Free-text columns the `q` search looks at.
export const COMPANY_SEARCH_FIELDS = ['name', 'domain', 'industry'] as const;

export const COMPANY_NAME_MAX_LENGTH = 200;
export const COMPANY_DOMAIN_MAX_LENGTH = 253;
export const COMPANY_INDUSTRY_MAX_LENGTH = 100;
export const COMPANY_ADDRESS_MAX_LENGTH = 500;
