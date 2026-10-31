import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { TenantContextService } from './tenant/tenant-context.service';

@Global()
@Module({
  imports: [ClsModule.forRoot({ global: true, middleware: { mount: true } })],
  providers: [TenantContextService, { provide: APP_FILTER, useClass: AllExceptionsFilter }],
  exports: [TenantContextService],
})
export class CommonModule {}
