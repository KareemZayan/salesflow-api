import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { validationExceptionFactory } from './common/pipes/validation-exception.factory';
import { APP_CONFIG_KEY, AppConfig } from './config/app.config';
import { productionConfigWarnings } from './config/production-warnings';
import { HEALTH_ROUTE, READINESS_ROUTE } from './infrastructure/health/health.controller';
import { QUEUE_BOARD_ROUTE } from './infrastructure/queue/queue.constants';

export const SWAGGER_PATH = 'api/docs';

// Strict helmet defaults everywhere. Swagger UI and Bull Board need inline scripts and styles, so the
// CSP header is relaxed for those paths only, and only when they exist (docs: never in production;
// board: only when it is mounted). Every other path keeps the strict policy.
function securityHeaders(relaxed: { prefixes: readonly string[]; segments: readonly string[] }) {
  const strict = helmet();
  const noCsp = helmet({ contentSecurityPolicy: false });
  return (req: Request, res: Response, next: NextFunction): void => {
    const isRelaxed =
      relaxed.prefixes.some((prefix) => req.path.startsWith(prefix)) ||
      relaxed.segments.some((path) => hasPathPrefix(req.path, path));
    (isRelaxed ? noCsp : strict)(req, res, next);
  };
}

// Whole path segments only: `/api/v1/queues` matches `/api/v1/queues/x` but not `/api/v1/queues-x`.
// (Swagger keeps its plain prefix match, so `/api/docs-json` stays relaxed as before.)
function hasPathPrefix(requestPath: string, prefix: string): boolean {
  return requestPath === prefix || requestPath.startsWith(`${prefix}/`);
}

// Everything under the API prefix carries tokens or tenant data, so no browser or proxy cache may keep
// a copy. Not applied to what the prefix does not own: /health, Swagger, and the dev-only Bull Board
// UI (its HTML and static assets are the one place under the prefix that is not API data).
function noStore(apiPrefix: string, excluded: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const isApi =
      hasPathPrefix(req.path, apiPrefix) && !excluded.some((path) => hasPathPrefix(req.path, path));
    if (isApi) res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

// Shared by main.ts and e2e tests so tests exercise the exact production wiring.
export function configureApp(app: INestApplication): AppConfig {
  const config = app.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG_KEY);

  // Without this, behind a proxy every request appears to come from the proxy's IP (rate limiting).
  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', config.trustProxy);
  const boardPaths =
    config.queue.boardEnabled && config.nodeEnv !== 'production'
      ? [`/${config.globalPrefix}${QUEUE_BOARD_ROUTE}`]
      : [];
  app.use(
    securityHeaders({
      prefixes: config.nodeEnv !== 'production' ? [`/${SWAGGER_PATH}`] : [],
      segments: boardPaths,
    }),
  );
  app.use(noStore(`/${config.globalPrefix}`, boardPaths));

  const logger = new Logger('Config');
  for (const warning of productionConfigWarnings(config)) logger.warn(warning);

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
