import { Module } from '@nestjs/common';
import { OwnershipScopeService } from './ownership-scope.service';
import { VisibilityRepository } from './visibility.repository';

@Module({
  providers: [OwnershipScopeService, VisibilityRepository],
  exports: [OwnershipScopeService],
})
export class VisibilityModule {}
