import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('api'),
  API_VERSION: z.string().default('1'),
  // Comma-separated list of allowed origins.
  CORS_ORIGINS: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;
