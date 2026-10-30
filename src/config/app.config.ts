import { registerAs } from '@nestjs/config';
import { Env } from './env.schema';

export const APP_CONFIG_KEY = 'app';

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  globalPrefix: string;
  corsOrigins: string[];
}

export const appConfig = registerAs(
  APP_CONFIG_KEY,
  (): AppConfig => ({
    nodeEnv: process.env.NODE_ENV as Env['NODE_ENV'],
    port: Number(process.env.PORT),
    globalPrefix: `${process.env.API_PREFIX}/v${process.env.API_VERSION}`,
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  }),
);
