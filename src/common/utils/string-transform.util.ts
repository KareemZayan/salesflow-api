// class-transformer `@Transform` callbacks shared by every DTO that normalizes text input.
// Non-strings pass through untouched so the validators can reject them with a proper message.
type TransformParams = { value: unknown };

export const trimString = ({ value }: TransformParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const normalizeEmail = ({ value }: TransformParams): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

// For optional, clearable columns: a blank string means "no value", stored as NULL. `undefined`
// (field omitted) and `null` (explicit clear) pass through unchanged.
export const trimToNull = ({ value }: TransformParams): unknown => {
  const trimmed = trimString({ value });
  return trimmed === '' ? null : trimmed;
};

// For optional, case-insensitive columns (email, domain): trimmed, lowercased, blank stored as NULL.
export const trimLowerToNull = ({ value }: TransformParams): unknown => {
  const trimmed = trimToNull({ value });
  return typeof trimmed === 'string' ? trimmed.toLowerCase() : trimmed;
};

// For optional filters: surrounding spaces are noise, and a blank value means "no filter".
export const trimToUndefined = ({ value }: TransformParams): unknown => {
  const trimmed = trimString({ value });
  return trimmed === '' ? undefined : trimmed;
};
