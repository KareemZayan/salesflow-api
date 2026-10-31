import { Global, Module } from '@nestjs/common';
import { createTenantClient } from '../../common/tenant/tenant-scope.extension';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { PRISMA_TENANT } from './prisma.constants';
import { PrismaService } from './prisma.service';

// Global: every feature repository needs it, and it holds no business logic.
@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: PRISMA_TENANT,
      inject: [PrismaService, TenantContextService],
      useFactory: createTenantClient,
    },
  ],
  exports: [PrismaService, PRISMA_TENANT],
})
export class PrismaModule {}
