import { Module } from '@nestjs/common';
import { VisibilityModule } from '../../common/visibility/visibility.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { CompaniesModule } from '../companies/companies.module';
import { ContactsModule } from '../contacts/contacts.module';
import { DealsModule } from '../deals/deals.module';
import { LeadsModule } from '../leads/leads.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TaskAlertsService } from './task-alerts.service';
import { TasksController } from './tasks.controller';
import { TasksRepository } from './tasks.repository';
import { TasksService } from './tasks.service';

@Module({
  imports: [
    VisibilityModule,
    LeadsModule,
    DealsModule,
    ContactsModule,
    CompaniesModule,
    NotificationsModule,
    AuditLogsModule,
  ],
  controllers: [TasksController],
  providers: [TasksService, TasksRepository, TaskAlertsService],
  // The scheduled reminder / overdue jobs (src/jobs) call this.
  exports: [TaskAlertsService],
})
export class TasksModule {}
