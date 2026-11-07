import { createHash } from 'node:crypto';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { REPORT_CACHE_VERSION, ReportName } from './reports.constants';

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 32);

// `all` is the unrestricted admin scope. Every other scope is the sorted list of owner ids behind a
// hash, so two callers share an entry only when they may see exactly the same records: a manager's
// team and an admin can never read each other's numbers.
export function scopeFingerprint(scope: VisibilityScope): string {
  if (scope.kind === 'all') return 'all';
  return `owners-${digest([...scope.ownerIds].sort().join(','))}`;
}

// Parameters are the RESOLVED ones (dates after defaults, the pipeline id after the default
// pipeline was looked up), sorted by name, so a request without `from` does not share an entry with
// one written for yesterday's window.
function paramsFingerprint(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return digest(JSON.stringify(entries));
}

// reports:v1:<organizationId>:<report>:<scopeFingerprint>:<paramsHash>
export function reportCacheKey(
  organizationId: string,
  report: ReportName,
  scope: VisibilityScope,
  params: Record<string, string | undefined>,
): string {
  return [
    'reports',
    REPORT_CACHE_VERSION,
    organizationId,
    report,
    scopeFingerprint(scope),
    paramsFingerprint(params),
  ].join(':');
}
