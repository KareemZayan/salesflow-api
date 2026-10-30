import { validateEnv } from './validate-env';

describe('validateEnv', () => {
  it('applies defaults for an empty environment', () => {
    expect(validateEnv({})).toMatchObject({ NODE_ENV: 'development', PORT: 3000 });
  });

  it('coerces PORT to a number', () => {
    expect(validateEnv({ PORT: '4000' }).PORT).toBe(4000);
  });

  it('throws a descriptive error for invalid values', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
