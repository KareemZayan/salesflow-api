// How money crosses the API: a DECIMAL STRING, never a JSON number (a number would pass through a
// float on the way). Up to 12 integer digits and 2 decimals, matching `Decimal(14,2)`; no sign,
// no exponent ("1e3" is not an amount), no thousands separators. Zero is a valid amount.
export const MONEY_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
export const MONEY_DECIMALS = 2;
export const DEFAULT_MONEY_AMOUNT = '0.00';
