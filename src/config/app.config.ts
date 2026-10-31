import { registerAs } from '@nestjs/config';
import { Env } from './env.schema';

export const APP_CONFIG_KEY = 'app';

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  globalPrefix: string;
  corsOrigins: string[];
  logLevel: Env['LOG_LEVEL'];
  databaseUrl: string;
  redis: HostPort;
}

interface HostPort {
  host: string;
  port: number;
}

export const appConfig = registerAs(APP_CONFIG_KEY, (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV as Env['NODE_ENV'],
  port: Number(process.env.PORT),
  globalPrefix: `${process.env.API_PREFIX}/v${process.env.API_VERSION}`,
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL as Env['LOG_LEVEL'],
  databaseUrl: process.env.DATABASE_URL as string,
  redis: { host: process.env.REDIS_HOST as string, port: Number(process.env.REDIS_PORT) },
}));
