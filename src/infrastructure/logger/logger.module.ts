import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';

export const REQUEST_ID_HEADER = 'x-request-id';

// pino-http does not log bodies today; the body and top-level paths are a safety net for the day
// someone adds `req.body` to the serializer or logs a DTO.
const SECRET_FIELDS = [
  'password',
  'temporaryPassword',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'refreshToken',
];
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SECRET_FIELDS.flatMap((field) => [field, `*.${field}`, `req.body.${field}`]),
];

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { nodeEnv, logLevel } = configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);
        return {
          pinoHttp: {
            level: logLevel,
            // Reuse the caller's id for cross-service correlation, otherwise generate one.
            genReqId: (req, res) => {
              const incoming = req.headers[REQUEST_ID_HEADER];
              const id = typeof incoming === 'string' && incoming ? incoming : randomUUID();
              res.setHeader(REQUEST_ID_HEADER, id);
              return id;
            },
            redact: {
              paths: LOG_REDACT_PATHS,
              censor: '[REDACTED]',
            },
            // Pretty output only in dev; production stays structured JSON.
            transport: nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined,
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
