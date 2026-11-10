import { parseTrustProxy } from './app.config';
import { productionConfigWarnings } from './production-warnings';

const config = (overrides: Partial<Parameters<typeof productionConfigWarnings>[0]> = {}) => ({
  nodeEnv: 'production' as const,
  trustProxy: 1 as boolean | number | string,
  corsOrigins: ['https://app.example.com'],
  ...overrides,
});

describe('productionConfigWarnings', () => {
  it('is silent for a fully configured production', () => {
    expect(productionConfigWarnings(config())).toEqual([]);
  });

  it('warns about TRUST_PROXY=false in production', () => {
    const warnings = productionConfigWarnings(config({ trustProxy: false }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/TRUST_PROXY is false/);
  });

  it('warns that TRUST_PROXY=true lets a client forge X-Forwarded-For, and says to use a hop count', () => {
    const warnings = productionConfigWarnings(config({ trustProxy: true }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/TRUST_PROXY is true/);
    expect(warnings[0]).toMatch(/forge that header to bypass rate limiting/);
    expect(warnings[0]).toMatch(/fake IP into the audit log/);
    expect(warnings[0]).toMatch(/exact number of proxy hops/);
  });

  it('a hop count really is supported: "1" parses to the number 1, which Express treats as one hop', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('warns about an empty CORS_ORIGINS in production', () => {
    const warnings = productionConfigWarnings(config({ corsOrigins: [] }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/CORS_ORIGINS is empty/);
  });

  it('reports both when both are unset', () => {
    expect(productionConfigWarnings(config({ trustProxy: false, corsOrigins: [] }))).toHaveLength(
      2,
    );
  });

  it.each([1, 2, 'loopback, 10.0.0.0/8'])('does not warn about TRUST_PROXY=%s', (value) => {
    expect(productionConfigWarnings(config({ trustProxy: value }))).toEqual([]);
  });

  it.each(['development', 'test'] as const)(
    'never warns outside production (%s keeps the defaults without noise)',
    (nodeEnv) => {
      expect(
        productionConfigWarnings(config({ nodeEnv, trustProxy: false, corsOrigins: [] })),
      ).toEqual([]);
    },
  );
});
