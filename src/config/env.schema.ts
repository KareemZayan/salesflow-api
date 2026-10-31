import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('api'),
  API_VERSION: z.string().default('1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Comma-separated list of allowed origins.
  CORS_ORIGINS: z.string().default(''),
  // Prisma connection string. In Docker it is derived from the POSTGRES_* variables (see docker-compose.yml).
  DATABASE_URL: z.string().min(1),
  // Endpoint probed by /health/ready (TCP level until the BullMQ client exists in Phase 12).
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
});

export type Env = z.infer<typeof envSchema>;
