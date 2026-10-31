import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import { assertTestDatabase } from './test-database';

// Runs once before the integration suite: create the test database if missing, then migrate it.
export default async function setup(): Promise<void> {
  const databaseUrl = assertTestDatabase(process.env.TEST_DATABASE_URL);
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.slice(1));

  // The name passed the "_test" guard; the pattern also keeps it safe to use as an identifier.
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Unsupported test database name "${databaseName}"`);
  }

  url.pathname = '/postgres';
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  execFileSync(
    process.execPath,
    [join('node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' },
  );
}
