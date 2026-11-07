import { Module } from '@nestjs/common';
import { VisibilityModule } from '../../common/visibility/visibility.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { CompaniesModule } from '../companies/companies.module';
import { ContactsModule } from '../contacts/contacts.module';
import { DealsModule } from '../deals/deals.module';
import { LeadsModule } from '../leads/leads.module';
import { ActivitiesController } from './activities.controller';
import { ActivitiesListener } from './activities.listener';
import { ActivitiesRepository } from './activities.repository';
import { ActivitiesService } from './activities.service';

@Module({
  imports: [
    VisibilityModule,
    QueueModule,
    LeadsModule,
    DealsModule,
    ContactsModule,
    CompaniesModule,
  ],
  controllers: [ActivitiesController],
  providers: [ActivitiesService, ActivitiesRepository, ActivitiesListener],
  // The queue processor (src/jobs) writes through the service.
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
