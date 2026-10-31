import { PLACEHOLDER_ADMIN_PASSWORD, parseSeedEnv } from '../../prisma/seed/seed-env';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  SEED_ADMIN_EMAIL: 'admin@example.com',
  SEED_ADMIN_PASSWORD: 'a-long-enough-password',
};

describe('parseSeedEnv', () => {
  it('applies defaults and parses the demo flag', () => {
    const env = parseSeedEnv({ ...BASE, SEED_DEMO_DATA: 'true' });
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      SEED_ORG_SLUG: 'demo',
      SEED_DEMO_DATA: true,
    });
  });

  it('allows the placeholder password outside production', () => {
    expect(() =>
      parseSeedEnv({
        ...BASE,
        NODE_ENV: 'development',
        SEED_ADMIN_PASSWORD: PLACEHOLDER_ADMIN_PASSWORD,
      }),
    ).not.toThrow();
  });

  it('refuses the placeholder password in production', () => {
    expect(() =>
      parseSeedEnv({
        ...BASE,
        NODE_ENV: 'production',
        SEED_ADMIN_PASSWORD: PLACEHOLDER_ADMIN_PASSWORD,
      }),
    ).toThrow(/placeholder password/);
  });

  it('refuses demo data in production', () => {
    expect(() => parseSeedEnv({ ...BASE, NODE_ENV: 'production', SEED_DEMO_DATA: 'true' })).toThrow(
      /demo data/,
    );
  });

  it('refuses a short admin password and an invalid email', () => {
    expect(() => parseSeedEnv({ ...BASE, SEED_ADMIN_PASSWORD: 'short' })).toThrow(
      /SEED_ADMIN_PASSWORD/,
    );
    expect(() => parseSeedEnv({ ...BASE, SEED_ADMIN_EMAIL: 'nope' })).toThrow(/SEED_ADMIN_EMAIL/);
  });
});
