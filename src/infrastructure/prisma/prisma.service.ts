import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { PrismaClient } from '../../generated/prisma/client';

// Prisma 7 talks to Postgres through a driver adapter. The connection is opened lazily on the
// first query, so an unreachable database does not stop the app from booting: /health/ready
// reports it instead. Tenant scoping (client extension) is added in Phase 5.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    const { databaseUrl } = config.getOrThrow<AppConfig>(APP_CONFIG_KEY);
    super({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
