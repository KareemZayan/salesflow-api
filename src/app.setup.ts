import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { validationExceptionFactory } from './common/pipes/validation-exception.factory';
import { APP_CONFIG_KEY, AppConfig } from './config/app.config';
import { HEALTH_ROUTE, READINESS_ROUTE } from './infrastructure/health/health.controller';

export const SWAGGER_PATH = 'api/docs';

// Strict helmet defaults everywhere. Swagger UI needs inline scripts and styles, so the CSP header
// is relaxed for the docs path only, and only when the docs exist (never in production).
function securityHeaders(docsEnabled: boolean) {
  const strict = helmet();
  const docs = helmet({ contentSecurityPolicy: false });
  return (req: Request, res: Response, next: NextFunction): void => {
    const isDocs = docsEnabled && req.path.startsWith(`/${SWAGGER_PATH}`);
    (isDocs ? docs : strict)(req, res, next);
  };
}

// Shared by main.ts and e2e tests so tests exercise the exact production wiring.
export function configureApp(app: INestApplication): AppConfig {
  const config = app.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG_KEY);

  // Without this, behind a proxy every request appears to come from the proxy's IP (rate limiting).
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', config.trustProxy);
  app.use(securityHeaders(config.nodeEnv !== 'production'));

  app.setGlobalPrefix(config.globalPrefix, { exclude: [HEALTH_ROUTE, READINESS_ROUTE] });
  app.enableCors({ origin: config.corsOrigins });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );

  // Swagger is a development tool only; it is never mounted in production.
  if (config.nodeEnv !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('SalesFlow CRM API').setVersion('1').addBearerAuth().build(),
    );
    SwaggerModule.setup(SWAGGER_PATH, app, document);
  }
  return config;
}
