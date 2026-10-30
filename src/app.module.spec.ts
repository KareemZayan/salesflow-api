import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { APP_CONFIG_KEY, AppConfig } from './config/app.config';

// Smoke test: proves SWC emits decorator metadata and DI + typed config resolve.
describe('AppModule', () => {
  it('boots and exposes typed app config', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const config = moduleRef.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG_KEY);
    expect(config.globalPrefix).toBe('api/v1');
    expect(config.port).toBeGreaterThan(0);
  });
});
