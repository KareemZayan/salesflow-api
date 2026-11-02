import { Module } from '@nestjs/common';
import { PermissionsController } from './permissions.controller';
import { RolesController } from './roles.controller';
import { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

@Module({
  controllers: [RolesController, PermissionsController],
  providers: [RolesService, RolesRepository],
})
export class RolesModule {}
