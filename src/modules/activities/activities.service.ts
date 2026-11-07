import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { CursorQueryDto } from '../../common/dto/cursor-query.dto';
import { CursorPaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { DomainException } from '../../common/exceptions/domain.exception';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { decodeKeysetCursor, encodeKeysetCursor } from '../../common/utils/keyset-cursor.util';
import { buildCursorPage } from '../../common/utils/pagination.util';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { CompaniesService } from '../companies/companies.service';
import { ContactsService } from '../contacts/contacts.service';
import { DealsService } from '../deals/deals.service';
import { LeadsService } from '../leads/leads.service';
import { isManualActivityType } from './activities.constants';
import { referencedDealId, toActivityResponse } from './activities.mapper';
import { ActivitiesRepository, ActivityRecord, CreateOutcome } from './activities.repository';
import { CreateActivityJob } from './activity-job';
import { ActivityParent, parentOf } from './activity-parent';
import { ActivityResponseDto } from './dto/activity-response.dto';
import { CreateActivityDto } from './dto/create-activity.dto';

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly repository: ActivitiesRepository,
    private readonly ownership: OwnershipScopeService,
    private readonly leads: LeadsService,
    private readonly deals: DealsService,
    private readonly contacts: ContactsService,
    private readonly companies: CompaniesService,
  ) {}

  // The parent is checked FIRST, with the module's own visible-or-404 read: a record the caller
  // cannot see answers 404 before any activity query runs, so a timeline never confirms that a
  // hidden record exists.
  async list(
    actor: AuthenticatedUser,
    parent: ActivityParent,
    { cursor, limit }: CursorQueryDto,
  ): Promise<CursorPaginatedResponseDto<ActivityResponseDto>> {
    await this.assertParentVisible(actor, parent);
    const after = cursor ? decodeKeysetCursor(cursor, actor.organizationId) : undefined;
    const rows = await this.repository.findPage(parent, after, limit + 1);
    const page = buildCursorPage(rows, limit, (last) =>
      encodeKeysetCursor(actor.organizationId, { at: last.occurredAt, id: last.id }),
    );
    const visibleDeals = await this.visibleDeals(actor, parent, page.data);
    return {
      ...page,
      data: page.data.map((row) => {
        const dealId = referencedDealId(row);
        return toActivityResponse(
          row,
          parent.kind === 'deal' || !dealId || visibleDeals.has(dealId),
        );
      }),
    };
  }

  async createManual(
    actor: AuthenticatedUser,
    parent: ActivityParent,
    dto: CreateActivityDto,
  ): Promise<ActivityResponseDto> {
    await this.assertParentVisible(actor, parent);
    const created = await this.repository.createManual({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      parent,
      ...dto,
    });
    return toActivityResponse(created, true);
  }

  // Who may delete what (ADR 0013). Everything that is not "visible to the caller" is the one 404.
  //   - missing / other organization / parent not visible to a non-admin: 404
  //   - a system entry (visible to the caller): 409 ACTIVITY_IMMUTABLE, whoever asks
  //   - a manual entry of someone else, caller not admin: 403 ACTIVITY_DELETE_RESTRICTED
  //   - a manual entry: its author while they still see the parent, or any admin
  // An admin sees the whole organization, so the parent check is skipped for them.
  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    const activity = await this.repository.findOne(id);
    if (!activity) throw resourceNotFound('Activity');
    const isAdmin = (await this.ownership.resolve(actor)).kind === 'all';

    if (!isAdmin) {
      const parent = parentOf(activity);
      if (!parent || !(await this.isParentVisible(actor, parent)))
        throw resourceNotFound('Activity');
    }
    if (!isManualActivityType(activity.type)) {
      throw new DomainException(
        ERROR_CODES.ACTIVITY_IMMUTABLE,
        'System timeline entries cannot be deleted',
        HttpStatus.CONFLICT,
      );
    }
    if (!isAdmin && activity.actorId !== actor.userId) {
      throw new DomainException(
        ERROR_CODES.ACTIVITY_DELETE_RESTRICTED,
        'Only the author or an admin can delete this entry',
        HttpStatus.FORBIDDEN,
      );
    }
    // The author / manual guard is repeated inside the statement: a lost race is a 404.
    const deleted = await this.repository.deleteManual(id, isAdmin ? undefined : actor.userId);
    if (!deleted) throw resourceNotFound('Activity');
  }

  // The write side of the queue job. Safe to run any number of times for the same job.
  createFromJob(job: CreateActivityJob): Promise<CreateOutcome> {
    return this.repository.createIfAbsent(job);
  }

  // Deal details inside an entry of ANOTHER record's timeline are shown only for deals the caller
  // may see. One query for the whole page (at most `limit` ids). A deal timeline needs none: the
  // parent check already proved the caller sees that deal.
  private async visibleDeals(
    actor: AuthenticatedUser,
    parent: ActivityParent,
    rows: ActivityRecord[],
  ): Promise<ReadonlySet<string>> {
    if (parent.kind === 'deal') return new Set();
    const ids = new Set<string>();
    for (const row of rows) {
      const dealId = referencedDealId(row);
      if (dealId) ids.add(dealId);
    }
    return this.deals.visibleIds(actor, [...ids]);
  }

  private async assertParentVisible(actor: AuthenticatedUser, { kind, id }: ActivityParent) {
    switch (kind) {
      case 'lead':
        return this.leads.get(actor, id);
      case 'deal':
        return this.deals.get(actor, id);
      case 'contact':
        return this.contacts.get(actor, id);
      case 'company':
        return this.companies.get(actor, id);
    }
  }

  private async isParentVisible(
    actor: AuthenticatedUser,
    parent: ActivityParent,
  ): Promise<boolean> {
    try {
      await this.assertParentVisible(actor, parent);
      return true;
    } catch (error) {
      // Only "not found" means hidden; a database error must stay an error.
      if (error instanceof HttpException && error.getStatus() === HttpStatus.NOT_FOUND)
        return false;
      throw error;
    }
  }
}
