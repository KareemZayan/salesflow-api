import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsController } from './permissions.controller';
import { RolesController } from './roles.controller';
import { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [RolesController, PermissionsController],
  providers: [RolesService, RolesRepository],
})
export class RolesModule {}
