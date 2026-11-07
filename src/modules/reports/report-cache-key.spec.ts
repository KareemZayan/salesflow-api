import { VisibilityScope } from '../../common/visibility/visibility.types';
import { reportCacheKey, scopeFingerprint } from './report-cache-key';
import { REPORT_NAMES, ReportName } from './reports.constants';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const all: VisibilityScope = { kind: 'all' };
const team = (...ownerIds: string[]): VisibilityScope => ({ kind: 'owners', ownerIds });

describe('scopeFingerprint', () => {
  it('is `all` for the unrestricted scope', () => {
    expect(scopeFingerprint(all)).toBe('all');
  });

  it('does not depend on the order of the owner ids', () => {
    expect(scopeFingerprint(team('u1', 'u2', 'u3'))).toBe(scopeFingerprint(team('u3', 'u1', 'u2')));
  });

  it('differs for different teams, including a team that is a subset', () => {
    const fingerprints = [team('u1'), team('u1', 'u2'), team('u1', 'u3')].map(scopeFingerprint);
    expect(new Set(fingerprints).size).toBe(3);
    expect(fingerprints).not.toContain('all');
  });

  it('never contains an owner id in clear', () => {
    expect(scopeFingerprint(team('user-secret-id'))).not.toContain('user-secret-id');
  });
});

describe('reportCacheKey', () => {
  const params = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
  const key = (
    org = ORG_A,
    report: ReportName = REPORT_NAMES.WIN_RATE,
    scope: VisibilityScope = all,
    given: Record<string, string | undefined> = params,
  ) => reportCacheKey(org, report, scope, given);

  it('has the documented shape reports:v1:<org>:<report>:<scope>:<params>', () => {
    const parts = key().split(':');
    expect(parts.slice(0, 5)).toEqual(['reports', 'v1', ORG_A, 'win-rate', 'all']);
    expect(parts[5]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts).toHaveLength(6);
  });

  it('is stable for the same inputs, whatever the parameter order', () => {
    expect(key()).toBe(
      key(ORG_A, REPORT_NAMES.WIN_RATE, all, { to: params.to, from: params.from }),
    );
  });

  it('differs by organization, report, scope and every parameter', () => {
    const keys = [
      key(),
      key(ORG_B),
      key(ORG_A, REPORT_NAMES.LEAD_CONVERSION),
      key(ORG_A, REPORT_NAMES.WIN_RATE, team('m1', 'r1')),
      key(ORG_A, REPORT_NAMES.WIN_RATE, team('m1', 'r2')),
      key(ORG_A, REPORT_NAMES.WIN_RATE, all, { ...params, to: '2026-03-01T00:00:00.000Z' }),
      key(ORG_A, REPORT_NAMES.WIN_RATE, all, { ...params, from: '2025-12-01T00:00:00.000Z' }),
      key(ORG_A, REPORT_NAMES.WIN_RATE, all, { ...params, interval: 'week' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('an absent parameter and a missing key are the same request', () => {
    expect(key(ORG_A, REPORT_NAMES.WIN_RATE, all, { ...params, interval: undefined })).toBe(key());
  });

  it('a manager scope and the admin scope never share a key', () => {
    expect(key(ORG_A, REPORT_NAMES.WIN_RATE, team('m1'))).not.toBe(key());
  });
});
