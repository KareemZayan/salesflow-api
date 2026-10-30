import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG_KEY, AppConfig } from './config/app.config';
import { HEALTH_ROUTE, READINESS_ROUTE } from './infrastructure/health/health.controller';

// Shared by main.ts and e2e tests so tests exercise the exact production wiring.
export function configureApp(app: INestApplication): AppConfig {
  const config = app.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG_KEY);

  app.setGlobalPrefix(config.globalPrefix, { exclude: [HEALTH_ROUTE, READINESS_ROUTE] });
  app.enableCors({ origin: config.corsOrigins });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  return config;
}
