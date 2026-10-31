import { validateEnv } from './validate-env';

const BASE_ENV = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('validateEnv', () => {
  it('applies defaults for an empty environment', () => {
    expect(validateEnv(BASE_ENV)).toMatchObject({ NODE_ENV: 'development', PORT: 3000 });
  });

  it('coerces PORT to a number', () => {
    expect(validateEnv({ ...BASE_ENV, PORT: '4000' }).PORT).toBe(4000);
  });

  it('requires DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('throws a descriptive error for invalid values', () => {
    expect(() => validateEnv({ ...BASE_ENV, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
