import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';

export const REQUEST_ID_HEADER = 'x-request-id';

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
              paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
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
