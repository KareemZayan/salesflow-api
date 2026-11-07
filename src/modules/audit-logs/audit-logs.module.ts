import { Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsRepository } from './audit-logs.repository';
import { AuditLogsService } from './audit-logs.service';
import { AuditService } from './audit.service';

// `AuditService` is what other modules import this module for: one `record(tx, entry)` call inside
// their own transaction. The read API and the retention job use `AuditLogsService`.
@Module({
  controllers: [AuditLogsController],
  providers: [AuditService, AuditLogsService, AuditLogsRepository],
  exports: [AuditService, AuditLogsService],
})
export class AuditLogsModule {}
