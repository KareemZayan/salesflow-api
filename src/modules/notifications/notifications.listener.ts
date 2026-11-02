import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { DealsService } from '../deals/deals.service';
import {
  DEAL_STAGE_CHANGED_EVENT,
  DealStageChangedEvent,
} from '../deals/events/deal-stage-changed.event';
import { LEAD_CONVERTED_EVENT, LeadConvertedEvent } from '../leads/events/lead-converted.event';
import { TASK_ASSIGNED_EVENT, TaskAssignedEvent } from '../tasks/events/task-assigned.event';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { dealStageChangedJob, leadConvertedJob, taskAssignedJob } from './notification-job.factory';

// Observer: turns domain events into notification jobs. It owns no rules of its own; who is told,
// and what the text says, lives in the factory.
@Injectable()
export class NotificationsListener {
  constructor(
    private readonly dispatcher: NotificationDispatcher,
    private readonly deals: DealsService,
    private readonly tenant: TenantContextService,
  ) {}

  @OnEvent(TASK_ASSIGNED_EVENT)
  onTaskAssigned(event: TaskAssignedEvent): Promise<void> {
    return this.dispatcher.dispatch(taskAssignedJob(event));
  }

  @OnEvent(LEAD_CONVERTED_EVENT)
  onLeadConverted(event: LeadConvertedEvent): Promise<void> {
    return this.dispatcher.dispatch(leadConvertedJob(event));
  }

  // The event carries no owner (ids only), so the CURRENT owner is read here. A deal deleted in
  // the meantime has nobody to notify.
  @OnEvent(DEAL_STAGE_CHANGED_EVENT)
  async onDealStageChanged(event: DealStageChangedEvent): Promise<void> {
    const ownerId = await this.tenant.run(event.organizationId, () =>
      this.deals.findOwnerId(event.dealId),
    );
    if (ownerId) await this.dispatcher.dispatch(dealStageChangedJob(event, ownerId));
  }
}
