export const DEAL_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'amount',
  'expectedCloseDate',
  'title',
] as const;
// Free-text columns the `q` search looks at.
export const DEAL_SEARCH_FIELDS = ['title'] as const;

export const DEAL_TITLE_MAX_LENGTH = 200;
export const DEAL_HISTORY_SORT_FIELDS = ['changedAt'] as const;
export const LOST_REASON_MAX_LENGTH = 500;
