// ISO 4217 alpha codes as known to the runtime (ICU data), so new currencies need no code change.
// Self-contained: also used by the org:create CLI.
let known: ReadonlySet<string> | undefined;

export function isCurrencyCode(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return false;
  known ??= new Set(Intl.supportedValuesOf('currency'));
  return known.has(value);
}
