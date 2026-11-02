import { Module } from '@nestjs/common';
import { VisibilityModule } from '../../common/visibility/visibility.module';
import { CompaniesModule } from '../companies/companies.module';
import { ContactsModule } from '../contacts/contacts.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { DealsController } from './deals.controller';
import { DealsRepository } from './deals.repository';
import { DealsService } from './deals.service';

@Module({
  imports: [
    VisibilityModule,
    PipelinesModule,
    CompaniesModule,
    ContactsModule,
    OrganizationsModule,
  ],
  controllers: [DealsController],
  providers: [DealsService, DealsRepository],
  exports: [DealsService],
})
export class DealsModule {}
