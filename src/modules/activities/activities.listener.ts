import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { enqueueBestEffort } from '../../infrastructure/queue/best-effort-enqueue';
import { JobQueueService } from '../../infrastructure/queue/job-queue.service';
import { QUEUE_NAMES } from '../../infrastructure/queue/queue.constants';
import { DealsService } from '../deals/deals.service';
import {
  DEAL_STAGE_CHANGED_EVENT,
  DealStageChangedEvent,
} from '../deals/events/deal-stage-changed.event';
import { LEAD_ASSIGNED_EVENT, LeadAssignedEvent } from '../leads/events/lead-assigned.event';
import { LEAD_CONVERTED_EVENT, LeadConvertedEvent } from '../leads/events/lead-converted.event';
import {
  LEAD_STATUS_CHANGED_EVENT,
  LeadStatusChangedEvent,
} from '../leads/events/lead-status-changed.event';
import { CREATE_ACTIVITY_JOB, CreateActivityJob } from './activity-job';
import {
  dealStageChangedJobs,
  leadAssignedJobs,
  leadConvertedJobs,
  leadStatusChangedJobs,
} from './activity-job.factory';

// Observer: turns domain events into timeline jobs. It owns no wording or rules; the factory does.
// Best effort by design: a lost event is a missing timeline entry, acceptable here (unlike the audit
// trail, 13b); ADR 0013.
@Injectable()
export class ActivitiesListener {
  private readonly logger = new Logger(ActivitiesListener.name);

  constructor(
    private readonly queue: JobQueueService,
    private readonly deals: DealsService,
    private readonly tenant: TenantContextService,
  ) {}

  @OnEvent(LEAD_CONVERTED_EVENT)
  onLeadConverted(event: LeadConvertedEvent): Promise<void> {
    return this.dispatch(leadConvertedJobs(event));
  }

  @OnEvent(LEAD_STATUS_CHANGED_EVENT)
  onLeadStatusChanged(event: LeadStatusChangedEvent): Promise<void> {
    return this.dispatch(leadStatusChangedJobs(event));
  }

  @OnEvent(LEAD_ASSIGNED_EVENT)
  onLeadAssigned(event: LeadAssignedEvent): Promise<void> {
    return this.dispatch(leadAssignedJobs(event));
  }

  // The event carries no contact or company (ids only), so the deal's CURRENT parties are read.
  // A deal deleted in the meantime has no parties: it still gets its own entry (the FK decides).
  @OnEvent(DEAL_STAGE_CHANGED_EVENT)
  async onDealStageChanged(event: DealStageChangedEvent): Promise<void> {
    const parties = await this.tenant.run(event.organizationId, () =>
      this.deals.findParties(event.dealId),
    );
    await this.dispatch(
      dealStageChangedJobs(event, parties ?? { contactId: null, companyId: null }),
    );
  }

  // One job per target, each with its own key; a failed enqueue does not stop the others.
  private async dispatch(jobs: CreateActivityJob[]): Promise<void> {
    await Promise.all(
      jobs.map((job) =>
        // The key names the event and the record; the subject and metadata are never logged.
        enqueueBestEffort(this.logger, `an activity (${job.dedupeKey})`, () =>
          this.queue.enqueue(QUEUE_NAMES.ACTIVITIES, CREATE_ACTIVITY_JOB, job, {
            jobId: job.dedupeKey,
          }),
        ),
      ),
    );
  }
}
