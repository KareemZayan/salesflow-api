import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer loads .env on its own. Docker injects env vars directly, so the file is optional.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed/index.ts',
  },
  datasource: {
    // `prisma generate` runs in the Docker build stage without a database; the URL is only needed by migrate/seed.
    url: process.env.DATABASE_URL ?? '',
  },
});
