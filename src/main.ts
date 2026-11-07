import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  // bufferLogs holds early Nest logs until pino is attached, so all output is structured.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = configureApp(app);
  // Without this, SIGTERM (docker stop, a deploy) kills the process at once and the BullMQ workers'
  // graceful close (QueueWorkersService.onModuleDestroy: finish the running job, bounded) never runs.
  // Here and not in configureApp, so the e2e apps do not each register process signal handlers.
  app.enableShutdownHooks();

  await app.listen(config.port);
}

void bootstrap();
