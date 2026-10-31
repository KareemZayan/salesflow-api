import { assertTestDatabase } from '../setup/test-database';

describe('assertTestDatabase', () => {
  it('accepts a database whose name ends with _test', () => {
    const url = 'postgresql://u:p@localhost:5432/salesflow_test?schema=public';
    expect(assertTestDatabase(url)).toBe(url);
  });

  it.each([
    'postgresql://u:p@localhost:5432/salesflow',
    'postgresql://u:p@localhost:5432/test_data',
  ])('refuses %s', (url) => {
    expect(() => assertTestDatabase(url)).toThrow(/Refusing to run/);
  });

  it('refuses when the variable is missing', () => {
    expect(() => assertTestDatabase(undefined)).toThrow(/TEST_DATABASE_URL/);
  });
});
