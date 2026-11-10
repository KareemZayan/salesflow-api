import { parseTrustProxy } from './app.config';
import { validateEnv } from './validate-env';

const BASE_ENV = {
  NODE_ENV: 'development',
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
      validateEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        REDIS_PASSWORD: 'a-real-secret',
        QUEUE_BOARD_ENABLED: 'false',
      }),
    ).not.toThrow();
  });

  it('rejects anything but true/false', () => {
    expect(() => validateEnv({ ...BASE_ENV, QUEUE_BOARD_ENABLED: 'yes' })).toThrow(
      /QUEUE_BOARD_ENABLED/,
    );
  });
});

describe('database pool and timeouts (ADR 0016)', () => {
  it('has defaults whose ordering holds: statement < transaction < idle-in-transaction', () => {
    const env = validateEnv(BASE_ENV);
    expect(env).toMatchObject({
      DB_POOL_MAX: 10,
      DB_POOL_ACQUIRE_TIMEOUT_MS: 5000,
      DB_TRANSACTION_TIMEOUT_MS: 10000,
      DB_STATEMENT_TIMEOUT_MS: 8000,
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: 30000,
    });
    expect(env.DB_STATEMENT_TIMEOUT_MS).toBeLessThan(env.DB_TRANSACTION_TIMEOUT_MS);
    expect(env.DB_TRANSACTION_TIMEOUT_MS).toBeLessThan(env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  });

  it('rejects a statement timeout that is not below the transaction timeout', () => {
    // Prisma cannot interrupt a statement blocked on a lock; only the server-side limit can.
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        DB_STATEMENT_TIMEOUT_MS: '10000',
        DB_TRANSACTION_TIMEOUT_MS: '10000',
      }),
    ).toThrow(/DB_STATEMENT_TIMEOUT_MS: must be smaller than DB_TRANSACTION_TIMEOUT_MS/);
  });

  it('rejects an idle-in-transaction limit that is not above the transaction timeout', () => {
    expect(() => validateEnv({ ...BASE_ENV, DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '10000' })).toThrow(
      /DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: must be larger than DB_TRANSACTION_TIMEOUT_MS/,
    );
  });

  it.each([
    ['DB_POOL_MAX', '0'],
    ['DB_POOL_MAX', '101'],
    ['DB_POOL_ACQUIRE_TIMEOUT_MS', '0'],
    ['DB_TRANSACTION_TIMEOUT_MS', '500'],
    ['DB_STATEMENT_TIMEOUT_MS', 'abc'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => validateEnv({ ...BASE_ENV, [key]: value })).toThrow(new RegExp(key));
  });
});

describe('validateEnv: NODE_ENV (required, no default)', () => {
  const withoutNodeEnv: Record<string, string> = { ...BASE_ENV };
  delete withoutNodeEnv.NODE_ENV;

  it('refuses to start when it is missing, instead of assuming development', () => {
    expect(() => validateEnv(withoutNodeEnv)).toThrow(
      /NODE_ENV: is required; set it to development, test or production/,
    );
  });

  it.each(['', 'staging', 'Production', 'prod', ' production'])(
    'rejects the unsupported value %j and does not say it is missing',
    (value) => {
      expect(() => validateEnv({ ...BASE_ENV, NODE_ENV: value })).toThrow(
        /NODE_ENV: must be one of development, test, production/,
      );
    },
  );

  it.each(['development', 'test'])('accepts %s', (value) => {
    expect(validateEnv({ ...BASE_ENV, NODE_ENV: value }).NODE_ENV).toBe(value);
  });

  it('accepts production with its required settings', () => {
    expect(
      validateEnv({ ...BASE_ENV, NODE_ENV: 'production', REDIS_PASSWORD: 'a-real-secret' })
        .NODE_ENV,
    ).toBe('production');
  });
});

describe('validateEnv: production guards', () => {
  const production = { ...BASE_ENV, NODE_ENV: 'production' };

  it.each([
    ['missing', {}],
    ['empty', { REDIS_PASSWORD: '' }],
    ['only whitespace', { REDIS_PASSWORD: '   ' }],
  ])('requires a Redis password in production (%s)', (_label, extra) => {
    expect(() => validateEnv({ ...production, ...extra })).toThrow(
      /REDIS_PASSWORD: is required when NODE_ENV=production/,
    );
  });

  it('accepts a non-empty Redis password in production', () => {
    expect(() => validateEnv({ ...production, REDIS_PASSWORD: 'a-real-secret' })).not.toThrow();
  });

  it.each(['development', 'test'])('does not require a Redis password in %s', (nodeEnv) => {
    expect(() => validateEnv({ ...BASE_ENV, NODE_ENV: nodeEnv })).not.toThrow();
  });

  it('reports every production problem at once, not one per restart', () => {
    expect(() => validateEnv({ ...production, QUEUE_BOARD_ENABLED: 'true' })).toThrow(
      /QUEUE_BOARD_ENABLED.*REDIS_PASSWORD|REDIS_PASSWORD.*QUEUE_BOARD_ENABLED/,
    );
  });
});

describe('validateEnv: THROTTLE_STORAGE', () => {
  it('defaults to redis (the secure choice needs no setting)', () => {
    expect(validateEnv(BASE_ENV).THROTTLE_STORAGE).toBe('redis');
  });

  it.each(['development', 'test'])('accepts memory in %s', (nodeEnv) => {
    expect(
      validateEnv({ ...BASE_ENV, NODE_ENV: nodeEnv, THROTTLE_STORAGE: 'memory' }).THROTTLE_STORAGE,
    ).toBe('memory');
  });

  it('refuses memory in production: per-process counters multiply the brute-force allowance', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        REDIS_PASSWORD: 'a-real-secret',
        THROTTLE_STORAGE: 'memory',
      }),
    ).toThrow(/THROTTLE_STORAGE: must be redis when NODE_ENV=production/);
  });

  it('accepts redis in production', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        NODE_ENV: 'production',
        REDIS_PASSWORD: 'a-real-secret',
        THROTTLE_STORAGE: 'redis',
      }),
    ).not.toThrow();
  });

  it('rejects anything else', () => {
    expect(() => validateEnv({ ...BASE_ENV, THROTTLE_STORAGE: 'off' })).toThrow(/THROTTLE_STORAGE/);
  });
});

describe('validateEnv: THROTTLE_AUTH_IP_LIMIT (15c.1)', () => {
  it('defaults to 120 per window, above the per-account default of 10', () => {
    const env = validateEnv(BASE_ENV);
    expect(env.THROTTLE_AUTH_IP_LIMIT).toBe(120);
    expect(env.THROTTLE_AUTH_IP_LIMIT).toBeGreaterThan(env.THROTTLE_AUTH_LIMIT);
  });

  it('is configurable', () => {
    expect(validateEnv({ ...BASE_ENV, THROTTLE_AUTH_IP_LIMIT: '300' }).THROTTLE_AUTH_IP_LIMIT).toBe(
      300,
    );
  });

  it('may equal the per-account limit', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, THROTTLE_AUTH_LIMIT: '25', THROTTLE_AUTH_IP_LIMIT: '25' }),
    ).not.toThrow();
  });

  it('must not be smaller than the per-account limit: the account limit could never be reached', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, THROTTLE_AUTH_LIMIT: '50', THROTTLE_AUTH_IP_LIMIT: '49' }),
    ).toThrow(/THROTTLE_AUTH_IP_LIMIT: must not be smaller than THROTTLE_AUTH_LIMIT/);
  });

  it('is checked in production too, which still needs the Redis storage', () => {
    const production = { ...BASE_ENV, NODE_ENV: 'production', REDIS_PASSWORD: 'a-real-secret' };
    expect(() => validateEnv({ ...production, THROTTLE_AUTH_IP_LIMIT: '5' })).toThrow(
      /THROTTLE_AUTH_IP_LIMIT/,
    );
    expect(() => validateEnv(production)).not.toThrow();
  });

  it.each(['0', '-1', '1.5', 'many'])('rejects %s', (value) => {
    expect(() => validateEnv({ ...BASE_ENV, THROTTLE_AUTH_IP_LIMIT: value })).toThrow(
      /THROTTLE_AUTH_IP_LIMIT/,
    );
  });
});
