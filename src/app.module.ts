import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommonModule } from './common/common.module';
import { appConfig } from './config/app.config';
import { validateEnv } from './config/validate-env';
import { HealthModule } from './infrastructure/health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { LoggerModule } from './infrastructure/logger/logger.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { QueueBoardModule } from './infrastructure/queue/queue-board.module';
import { ActivitiesModule } from './modules/activities/activities.module';
import { AuditLogsModule } from './modules/audit-logs/audit-logs.module';
import { AuthModule } from './modules/auth/auth.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { DealsModule } from './modules/deals/deals.module';
import { LeadsModule } from './modules/leads/leads.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PipelinesModule } from './modules/pipelines/pipelines.module';
import { ReportsModule } from './modules/reports/reports.module';
import { RolesModule } from './modules/roles/roles.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig],
      validate: validateEnv,
    }),
    EventEmitterModule.forRoot(),
    CommonModule,
    LoggerModule,
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    RolesModule,
    OrganizationsModule,
    CompaniesModule,
    ContactsModule,
    LeadsModule,
    PipelinesModule,
    DealsModule,
    TasksModule,
    ActivitiesModule,
    NotificationsModule,
    AuditLogsModule,
    ReportsModule,
    JobsModule,
    // After ConfigModule.forRoot: whether it mounts is decided from the loaded environment.
    QueueBoardModule.register(),
  ],
})
export class AppModule {}
