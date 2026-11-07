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

describe('queue settings', () => {
  it('defaults to the "salesflow" prefix with workers on and no Redis password', () => {
    expect(validateEnv(BASE_ENV)).toMatchObject({
      QUEUE_PREFIX: 'salesflow',
      QUEUE_WORKERS_ENABLED: 'true',
      REDIS_PASSWORD: '',
    });
  });

  it('accepts workers switched off', () => {
    expect(validateEnv({ ...BASE_ENV, QUEUE_WORKERS_ENABLED: 'false' }).QUEUE_WORKERS_ENABLED).toBe(
      'false',
    );
  });

  it.each(['yes', '1', 'TRUE'])('rejects QUEUE_WORKERS_ENABLED=%s', (value) => {
    expect(() => validateEnv({ ...BASE_ENV, QUEUE_WORKERS_ENABLED: value })).toThrow(
      /QUEUE_WORKERS_ENABLED/,
    );
  });

  it.each(['a:b', 'has space', '', 'a*b'])('rejects the unsafe QUEUE_PREFIX "%s"', (value) => {
    expect(() => validateEnv({ ...BASE_ENV, QUEUE_PREFIX: value })).toThrow(/QUEUE_PREFIX/);
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

describe('validateEnv: QUEUE_BOARD_ENABLED', () => {
  it('defaults to false (the board is closed unless asked for)', () => {
    expect(validateEnv(BASE_ENV).QUEUE_BOARD_ENABLED).toBe('false');
  });

  it('accepts true outside production', () => {
    expect(
      validateEnv({ ...BASE_ENV, NODE_ENV: 'development', QUEUE_BOARD_ENABLED: 'true' })
        .QUEUE_BOARD_ENABLED,
    ).toBe('true');
  });

  it('refuses true in production instead of ignoring it', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, NODE_ENV: 'production', QUEUE_BOARD_ENABLED: 'true' }),
    ).toThrow(/QUEUE_BOARD_ENABLED.*NODE_ENV=production/);
  });

  it('accepts false in production', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, NODE_ENV: 'production', QUEUE_BOARD_ENABLED: 'false' }),
    ).not.toThrow();
  });

  it('rejects anything but true/false', () => {
    expect(() => validateEnv({ ...BASE_ENV, QUEUE_BOARD_ENABLED: 'yes' })).toThrow(
      /QUEUE_BOARD_ENABLED/,
    );
  });
});
