import { parseTrustProxy } from './app.config';
import { validateEnv } from './validate-env';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('applies defaults for a minimal environment', () => {
    expect(validateEnv(BASE_ENV)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      REFRESH_REUSE_GRACE_SECONDS: 10,
      TRUST_PROXY: 'false',
    });
  });

  it('coerces PORT to a number', () => {
    expect(validateEnv({ ...BASE_ENV, PORT: '4000' }).PORT).toBe(4000);
  });

  it('requires DATABASE_URL', () => {
    expect(() => validateEnv({ JWT_ACCESS_SECRET: BASE_ENV.JWT_ACCESS_SECRET })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('throws a descriptive error for invalid values', () => {
    expect(() => validateEnv({ ...BASE_ENV, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('requires a signing secret of at least 32 characters', () => {
    expect(() => validateEnv({ DATABASE_URL: BASE_ENV.DATABASE_URL })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => validateEnv({ ...BASE_ENV, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('rejects malformed token lifetimes', () => {
    expect(() => validateEnv({ ...BASE_ENV, JWT_ACCESS_EXPIRES_IN: '15 minutes' })).toThrow(
      /JWT_ACCESS_EXPIRES_IN/,
    );
  });
});

describe('parseTrustProxy', () => {
  it.each([
    ['false', false],
    ['true', true],
    ['1', 1],
    ['loopback', 'loopback'],
    ['10.0.0.0/8', '10.0.0.0/8'],
  ])('parses %s', (input, expected) => {
    expect(parseTrustProxy(input)).toBe(expected);
  });
});
