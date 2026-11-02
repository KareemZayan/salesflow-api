// LIKE treats `%` and `_` as wildcards and `\` as the escape character (Postgres' default). Prisma
// passes `contains` values through as typed, so user input must be escaped here or `q=%` would
// match every row. The backslash is escaped too, otherwise `q=\` would escape the closing wildcard.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

// Case-insensitive "contains" across several columns, or `undefined` when there is nothing to
// search for (so the caller can spread it into a where without a branch). `W` is the repository's
// Prisma `WhereInput`; the fields are always string columns of that model, hence the cast (same
// approach as applyVisibility).
export function containsAny<W extends object>(
  q: string | undefined,
  fields: readonly string[],
): { OR: W[] } | undefined {
  const term = q?.trim();
  if (!term) return undefined;
  const contains = escapeLike(term);
  return {
    OR: fields.map((field) => ({ [field]: { contains, mode: 'insensitive' } }) as W),
  };
}
