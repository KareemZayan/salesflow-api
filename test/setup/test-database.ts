// Integration tests TRUNCATE tables. This guard makes sure they can never touch a real database.
export const TEST_DATABASE_SUFFIX = '_test';

export function assertTestDatabase(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Error('TEST_DATABASE_URL is not set; refusing to run integration tests');
  }
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `Refusing to run: database "${name}" does not end with "${TEST_DATABASE_SUFFIX}"`,
    );
  }
  return databaseUrl;
}
