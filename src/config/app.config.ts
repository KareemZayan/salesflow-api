import { registerAs } from '@nestjs/config';
import { parseDurationMs } from '../common/utils/duration.util';
import { Env } from './env.schema';

export const APP_CONFIG_KEY = 'app';

export type TrustProxy = boolean | number | string;

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  globalPrefix: string;
  corsOrigins: string[];
  trustProxy: TrustProxy;
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  database: DatabaseConfig;
  redis: RedisConfig;
  queue: QueueConfig;
  auth: AuthConfig;
  throttle: ThrottleConfig;
}

export interface DatabaseConfig {
  poolMax: number;
  acquireTimeoutMs: number;
  transactionTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

export interface QueueConfig {
  prefix: string;
  workersEnabled: boolean;
  boardEnabled: boolean;
}

export interface AuthConfig {
  accessSecret: string;
  accessExpiresInSeconds: number;
  refreshExpiresInMs: number;
  refreshReuseGraceMs: number;
}

export interface ThrottleConfig {
  ttlMs: number;
  limit: number;
  authLimit: number;
}

export function parseTrustProxy(value: string): TrustProxy {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

export const appConfig = registerAs(APP_CONFIG_KEY, (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV as Env['NODE_ENV'],
  port: Number(process.env.PORT),
  globalPrefix: `${process.env.API_PREFIX}/v${process.env.API_VERSION}`,
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY as string),
  logLevel: process.env.LOG_LEVEL as Env['LOG_LEVEL'],
  databaseUrl: process.env.DATABASE_URL as string,
  database: {
    poolMax: Number(process.env.DB_POOL_MAX),
    acquireTimeoutMs: Number(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS),
    transactionTimeoutMs: Number(process.env.DB_TRANSACTION_TIMEOUT_MS),
    statementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS),
    idleInTransactionTimeoutMs: Number(process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS),
  },
  redis: {
    host: process.env.REDIS_HOST as string,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  queue: {
    prefix: process.env.QUEUE_PREFIX as string,
    workersEnabled: process.env.QUEUE_WORKERS_ENABLED === 'true',
    boardEnabled: process.env.QUEUE_BOARD_ENABLED === 'true',
  },
  auth: {
    accessSecret: process.env.JWT_ACCESS_SECRET as string,
    accessExpiresInSeconds: parseDurationMs(process.env.JWT_ACCESS_EXPIRES_IN as string) / 1000,
    refreshExpiresInMs: parseDurationMs(process.env.JWT_REFRESH_EXPIRES_IN as string),
    refreshReuseGraceMs: Number(process.env.REFRESH_REUSE_GRACE_SECONDS) * 1000,
  },
  throttle: {
    ttlMs: Number(process.env.THROTTLE_TTL_SECONDS) * 1000,
    limit: Number(process.env.THROTTLE_LIMIT),
    authLimit: Number(process.env.THROTTLE_AUTH_LIMIT),
  },
}));
