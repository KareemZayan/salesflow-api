import { PLACEHOLDER_PASSWORD as PLACEHOLDER_ADMIN_PASSWORD } from '../../src/common/policies/password-policy';
import { parseSeedEnv } from '../../prisma/seed/seed-env';

const BASE = {
  NODE_ENV: 'development',
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

  it('requires NODE_ENV: a forgotten value must not switch the production guards off', () => {
    const withoutNodeEnv: Record<string, string> = { ...BASE };
    delete withoutNodeEnv.NODE_ENV;
    expect(() => parseSeedEnv(withoutNodeEnv)).toThrow(/NODE_ENV: is required/);
    expect(() => parseSeedEnv({ ...BASE, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV: must be one of/,
    );
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
