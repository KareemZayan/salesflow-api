import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module';
import { appConfig } from './config/app.config';
import { validateEnv } from './config/validate-env';
import { HealthModule } from './infrastructure/health/health.module';
import { LoggerModule } from './infrastructure/logger/logger.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { LeadsModule } from './modules/leads/leads.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { RolesModule } from './modules/roles/roles.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig],
      validate: validateEnv,
    }),
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
  ],
})
export class AppModule {}
