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
  redis: HostPort;
  auth: AuthConfig;
  throttle: ThrottleConfig;
}

interface HostPort {
  host: string;
  port: number;
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
  redis: { host: process.env.REDIS_HOST as string, port: Number(process.env.REDIS_PORT) },
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
