import { Env, envSchema } from './env.schema';

// Fail fast at startup: invalid env must never reach runtime.
// Returns the parsed values (with defaults) so ConfigModule exposes them via process.env-backed config.
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const env = result.data;
  // Write defaults back so registerAs factories see complete values.
  for (const [key, value] of Object.entries(env)) process.env[key] = String(value);
  return env;
}
