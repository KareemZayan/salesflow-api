import { z } from 'zod';
import { DURATION_PATTERN } from '../common/utils/duration.util';

const duration = (fallback: string) =>
  z.string().regex(DURATION_PATTERN, 'must look like 30s, 15m, 2h or 7d').default(fallback);

export const envSchema = z
  .object({
    // Required, with no default: a missing value must not silently mean "not production" (that would
    // turn Swagger on and skip every production guard below). Docker sets it; see .env.example.
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      error: (issue) =>
        issue.input === undefined
          ? 'is required; set it to development, test or production'
          : 'must be one of development, test, production',
    }),
    PORT: z.coerce.number().int().positive().default(3000),
    API_PREFIX: z.string().default('api'),
    API_VERSION: z.string().default('1'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // Comma-separated list of allowed origins.
    CORS_ORIGINS: z.string().default(''),
    // Express "trust proxy": `false`, `true`, a hop count (`1`) or a subnet/name list (`loopback`).
    // Behind a reverse proxy it must be set, or every client shares the proxy's IP and the login
    // throttle counts them all together. Left `false` when the API is exposed directly.
    TRUST_PROXY: z.string().default('false'),
    // Prisma connection string. In Docker it is derived from the POSTGRES_* variables (see docker-compose.yml).
    DATABASE_URL: z.string().min(1),
    // Connection pool and timeouts. Sizing rules and the capacity arithmetic: ADR 0016.
    // Per API process (one pool each). All instances together must stay below PostgreSQL's
    // max_connections minus a reserve: DB_POOL_MAX <= floor((max_connections - 10) / instances).
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    // How long a request waits for a free connection (also the `maxWait` of a transaction) before it
    // is answered 503 DATABASE_BUSY. Short on purpose: a queue longer than a user will wait helps nobody.
    DB_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
    // Longest an interactive transaction may run, lock waits included (Prisma's own default is 5000).
    DB_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
    // Server-side cap on ONE statement, including a wait for a lock. Must stay below the transaction
    // timeout: Prisma cannot interrupt a statement blocked on a lock, PostgreSQL can.
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),
    // Server-side cap on a connection sitting idle inside an open transaction (a leaked transaction
    // would otherwise keep its locks). Must be larger than DB_TRANSACTION_TIMEOUT_MS so the client-side
    // limit always fires first.
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
    // Redis backs the BullMQ queues; /health/ready pings it through the queue connection.
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    // Blank = no authentication (the local compose Redis). Required when NODE_ENV=production.
    REDIS_PASSWORD: z.string().default(''),
    // Key prefix of every queue, so two environments (or e2e runs) can share one Redis safely.
    QUEUE_PREFIX: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, "-" and "_" only')
      .default('salesflow'),
    // false = this process only enqueues (API-only instance); true = it also runs the job workers.
    QUEUE_WORKERS_ENABLED: z.enum(['true', 'false']).default('true'),
    // Bull Board, the queue inspection UI. Closed by default. It has NO authentication and shows every
    // organization's job payloads, so it is for local development only: with NODE_ENV=production a
    // true value is a startup error (see the refinement below), never silently ignored.
    QUEUE_BOARD_ENABLED: z.enum(['true', 'false']).default('false'),
    // Access tokens are HS256 JWTs. Refresh tokens are opaque random values, so they need no secret.
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_EXPIRES_IN: duration('15m'),
    JWT_REFRESH_EXPIRES_IN: duration('7d'),
    // A refresh token rotated less than this long ago is a concurrent retry (409), not a replay.
    REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).default(10),
    // Global rate limit, and the stricter one for login (per IP + email) and other auth routes.
    THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),
    THROTTLE_AUTH_LIMIT: z.coerce.number().int().positive().default(10),
  })
  .superRefine((env, ctx) => {
    // Prisma's transaction timeout cannot interrupt a statement blocked on a lock (the connection
    // stays busy until the lock frees up); only the server-side statement timeout can. So it must be
    // the smaller of the two for the transaction limit to mean anything. ADR 0016.
    if (env.DB_STATEMENT_TIMEOUT_MS >= env.DB_TRANSACTION_TIMEOUT_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['DB_STATEMENT_TIMEOUT_MS'],
        message: 'must be smaller than DB_TRANSACTION_TIMEOUT_MS',
      });
    }
    if (env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS <= env.DB_TRANSACTION_TIMEOUT_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'],
        message: 'must be larger than DB_TRANSACTION_TIMEOUT_MS',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.QUEUE_BOARD_ENABLED === 'true') {
      ctx.addIssue({
        code: 'custom',
        path: ['QUEUE_BOARD_ENABLED'],
        message:
          'Bull Board has no authentication and must not be enabled when NODE_ENV=production',
      });
    }
    // Redis holds every organization's queued job payloads. Whitespace is not a password.
    if (env.REDIS_PASSWORD.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_PASSWORD'],
        message: 'is required when NODE_ENV=production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
