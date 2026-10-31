import { z } from 'zod';

// Shipped in .env.example. Running a production seed with it would create a known-password admin.
export const PLACEHOLDER_ADMIN_PASSWORD = 'change_me_strong_password';

const seedEnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SEED_DEMO_DATA: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SEED_ORG_NAME: z.string().min(1).default('Demo Organization'),
    SEED_ORG_SLUG: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a lowercase slug')
      .default('demo'),
    SEED_ADMIN_EMAIL: z.string().email(),
    SEED_ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.SEED_ADMIN_PASSWORD === PLACEHOLDER_ADMIN_PASSWORD) {
      ctx.addIssue({
        code: 'custom',
        path: ['SEED_ADMIN_PASSWORD'],
        message: 'the placeholder password is not allowed when NODE_ENV=production',
      });
    }
    if (env.SEED_DEMO_DATA) {
      ctx.addIssue({
        code: 'custom',
        path: ['SEED_DEMO_DATA'],
        message: 'demo data is not allowed when NODE_ENV=production',
      });
    }
  });

export type SeedEnv = z.infer<typeof seedEnvSchema>;

// Fail fast: a bad seed configuration must stop the container before the app starts.
export function parseSeedEnv(raw: Record<string, string | undefined>): SeedEnv {
  const result = seedEnvSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid seed configuration: ${details}`);
  }
  return result.data;
}
