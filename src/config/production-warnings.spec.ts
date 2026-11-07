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

  it.each([1, 2, 'loopback, 10.0.0.0/8', true])('does not warn about TRUST_PROXY=%s', (value) => {
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
