import { Module } from '@nestjs/common';
import { VisibilityModule } from '../../common/visibility/visibility.module';
import { CompaniesModule } from '../companies/companies.module';
import { ContactsModule } from '../contacts/contacts.module';
import { LeadConversionService } from './lead-conversion.service';
import { LeadsController } from './leads.controller';
import { LeadsRepository } from './leads.repository';
import { LeadsService } from './leads.service';
import { LEAD_SCORING_STRATEGY } from './scoring/lead-scoring.strategy';
import { RuleBasedLeadScoringStrategy } from './scoring/rule-based-lead-scoring.strategy';

@Module({
  imports: [VisibilityModule, CompaniesModule, ContactsModule],
  controllers: [LeadsController],
  providers: [
    LeadsService,
    LeadConversionService,
    LeadsRepository,
    // Swapping the scoring rules means changing this one line.
    { provide: LEAD_SCORING_STRATEGY, useClass: RuleBasedLeadScoringStrategy },
  ],
})
export class LeadsModule {}
