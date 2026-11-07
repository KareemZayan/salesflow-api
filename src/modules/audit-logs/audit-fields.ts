import { AuditEntityType } from './audit-events';

// What an audit row may store in `before` / `after`, per entity type (ADR 0014). An allowlist, not a
// blocklist: a column added to a table later is NOT audited until somebody lists it here on
// purpose. Never list a secret (password, hash, token) or long free text (notes, descriptions,
// titles): the log is kept for the retention period and read by administrators.
//
// `email` is personal data. It is stored on purpose (who was given which login address) and then
// lives as long as the retention period (AUDIT_RETENTION_DAYS).
export const AUDIT_FIELDS = {
  User: ['email', 'firstName', 'lastName', 'roleId', 'managerId', 'isActive'],
  Role: ['name', 'permissionKeys'],
  Organization: ['name', 'defaultCurrency'],
  Deal: ['amount', 'currency'],
  Task: ['assigneeId'],
} as const satisfies Record<AuditEntityType, readonly string[]>;

// Plain values only. Money is a string ("1250.00"), never a number or a Decimal.
export type AuditValue = string | number | boolean | null | string[];
export type AuditSnapshot = Record<string, AuditValue>;

// Safety net behind the allowlist: refuses the payload (the whole business change then rolls back)
// instead of storing it. Matches names, so a future field called "apiToken" cannot slip in.
export const FORBIDDEN_AUDIT_KEY =
  /pass(word|wd)|token|secret|hash|credential|authorization|cookie/i;
export const MAX_AUDIT_STRING_LENGTH = 255;
export const MAX_AUDIT_LIST_LENGTH = 200;

export class AuditPayloadError extends Error {}

const sameValue = (a: AuditValue | undefined, b: AuditValue | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export interface AuditDiff {
  before: AuditSnapshot | null;
  after: AuditSnapshot | null;
}

// Changed fields only. Create (no `before`) keeps every allowlisted field of `after`; delete (no
// `after`) keeps every allowlisted field of `before`. `null` = nothing changed, so there is nothing
// to record. A field outside the allowlist is dropped; a forbidden or oversized value throws.
export function diffForAudit(
  entityType: AuditEntityType,
  before: AuditSnapshot | undefined,
  after: AuditSnapshot | undefined,
): AuditDiff | null {
  const allowed: readonly string[] = AUDIT_FIELDS[entityType];
  const fields = allowed.filter(
    (field) => (before !== undefined && field in before) || (after !== undefined && field in after),
  );
  const changed =
    before && after ? fields.filter((field) => !sameValue(before[field], after[field])) : fields;
  if (before && after && changed.length === 0) return null;

  const pick = (snapshot: AuditSnapshot | undefined): AuditSnapshot | null =>
    snapshot
      ? Object.fromEntries(
          changed.filter((field) => field in snapshot).map((field) => [field, snapshot[field]]),
        )
      : null;
  const diff = { before: pick(before), after: pick(after) };
  assertAuditSafe(diff.before);
  assertAuditSafe(diff.after);
  return diff;
}

export function assertAuditSafe(snapshot: AuditSnapshot | null): void {
  if (!snapshot) return;
  for (const [key, value] of Object.entries(snapshot)) {
    if (FORBIDDEN_AUDIT_KEY.test(key)) throw new AuditPayloadError(`Forbidden audit field: ${key}`);
    const values = Array.isArray(value) ? value : [value];
    if (values.length > MAX_AUDIT_LIST_LENGTH) {
      throw new AuditPayloadError(`Audit field ${key} has too many entries`);
    }
    if (values.some((item) => typeof item === 'string' && item.length > MAX_AUDIT_STRING_LENGTH)) {
      throw new AuditPayloadError(`Audit field ${key} is too long`);
    }
  }
}
