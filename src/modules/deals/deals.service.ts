import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';
import { publishDomainEvent } from '../../common/events/publish-domain-event';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { DEFAULT_MONEY_AMOUNT } from '../../common/policies/money-policy';
import { assertHasChanges } from '../../common/utils/assert-has-changes.util';
import { applyStatusTransition } from '../../common/utils/status-transition.util';
import { dateOnlyToDate } from '../../common/validators/is-date-only.validator';
import { ownerForCreate, ownerForTransfer } from '../../common/visibility/owner-assignment';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { DealStatus } from '../../generated/prisma/client';
import { LockRequest } from '../../infrastructure/prisma/advisory-lock';
import { CompaniesService } from '../companies/companies.service';
import { ContactsService } from '../contacts/contacts.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { outcomeOfMove } from './deal-move';
import {
  DealClosedException,
  DealStageChangedException,
  InvalidStageMoveException,
} from './deals.exceptions';
import { toDealResponse } from './deals.mapper';
import { DealChanges, DealRecord, DealsRepository, DealsTx } from './deals.repository';
import { DEAL_STAGE_CHANGED_EVENT, DealStageChangedEvent } from './events/deal-stage-changed.event';
import { CreateDealDto } from './dto/create-deal.dto';
import { DealHistoryResponseDto } from './dto/deal-history-response.dto';
import { DealResponseDto } from './dto/deal-response.dto';
import { ListDealHistoryQueryDto } from './dto/list-deal-history-query.dto';
import { MoveDealDto } from './dto/move-deal.dto';
import { ListDealsQueryDto } from './dto/list-deals-query.dto';
import { UpdateDealDto } from './dto/update-deal.dto';

// What a new deal is made of once the caller has decided owner, currency and links. Shared by
// POST /deals and lead conversion (10d), which both place the deal inside their own transaction.
export interface NewDealInput {
  organizationId: string;
  actorId: string;
  ownerId: string;
  title: string;
  amount?: string;
  currency: string;
  pipelineId: string;
  stageId?: string;
  contactId?: string | null;
  companyId?: string | null;
  expectedCloseDate?: string | null;
}

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(
    private readonly repository: DealsRepository,
    private readonly ownership: OwnershipScopeService,
    private readonly pipelines: PipelinesService,
    private readonly companies: CompaniesService,
    private readonly contacts: ContactsService,
    private readonly organizations: OrganizationsService,
    private readonly events: EventEmitter2,
  ) {}

  async list(
    actor: AuthenticatedUser,
    query: ListDealsQueryDto,
  ): Promise<PaginatedResponseDto<DealResponseDto>> {
    const page = await this.repository.findPage(await this.ownership.resolve(actor), query);
    return { ...page, data: page.data.map(toDealResponse) };
  }

  async get(actor: AuthenticatedUser, id: string): Promise<DealResponseDto> {
    const deal = await this.repository.findVisible(await this.ownership.resolve(actor), id);
    if (!deal) throw resourceNotFound('Deal');
    return toDealResponse(deal);
  }

  // For system consumers (notifications) that react to an event and have no caller to authorize:
  // the tenant comes from the surrounding tenant context. Null = deleted or never existed.
  findOwnerId(dealId: string): Promise<string | null> {
    return this.repository.findOwnerId(dealId);
  }

  // For modules that link their records to a deal (tasks). Nothing blocks deleting a deal, so no lock
  // is needed. Missing, deleted, foreign and not-visible deals all give the same 400.
  async assertLinkable(scope: VisibilityScope, dealId: string): Promise<void> {
    if (await this.repository.findVisible(scope, dealId)) return;
    throw new DomainException(
      ERROR_CODES.INVALID_DEAL,
      'The deal must be one you are allowed to link',
      HttpStatus.BAD_REQUEST,
    );
  }

  // Locks (advisory-lock.ts, order pipeline -> company -> contact), all SHARED: placing a deal
  // needs the pipeline's stages and the linked records to stay as they are, but two deals do not
  // need to wait for each other. Stage/pipeline deletes (exclusive) and contact/company deletes
  // (exclusive) do wait for us, and count AFTER they hold the lock.
  async create(actor: AuthenticatedUser, dto: CreateDealDto): Promise<DealResponseDto> {
    const scope = await this.ownership.resolve(actor);
    const ownerId = await ownerForCreate(this.ownership, actor, dto.ownerId);
    const { currency, pipelineId } = await this.resolveDefaults(actor, dto);

    const deal = await this.repository.inLocks(
      sharedLocks(pipelineId, dto.companyId, dto.contactId),
      async (tx) => {
        await this.assertPartiesLinkable(tx, scope, dto.companyId, dto.contactId);
        return this.createWithin(tx, {
          organizationId: actor.organizationId,
          actorId: actor.userId,
          ownerId,
          title: dto.title,
          amount: dto.amount,
          currency,
          pipelineId,
          stageId: dto.stageId,
          contactId: dto.contactId,
          companyId: dto.companyId,
          expectedCloseDate: dto.expectedCloseDate,
        });
      },
    );
    return toDealResponse(deal);
  }

  // What a new deal falls back to when the request is silent: the organization currency and the
  // default pipeline. Resolved BEFORE the caller opens its transaction, because the pipeline id is
  // needed to take the (shared) pipeline lock; the placement itself is re-checked under that lock.
  async resolveDefaults(
    actor: AuthenticatedUser,
    given: { currency?: string; pipelineId?: string },
  ): Promise<{ currency: string; pipelineId: string }> {
    return {
      currency: given.currency ?? (await this.organizations.getCurrent(actor)).defaultCurrency,
      pipelineId: given.pipelineId ?? (await this.pipelines.defaultPipelineId()),
    };
  }

  // Inside the caller's transaction, which must already hold the pipeline lock (shared is enough).
  // The pipeline and stage are verified here, under that lock; the links are the caller's business
  // (POST /deals checks them, lead conversion has just created or checked them).
  async createWithin(db: DealsTx, input: NewDealInput): Promise<DealRecord> {
    const placement = await this.pipelines.resolvePlacement(db, input.pipelineId, input.stageId);
    return this.repository.createWithin(
      db,
      {
        organizationId: input.organizationId,
        ownerId: input.ownerId,
        ...placement,
        contactId: input.contactId,
        companyId: input.companyId,
        title: input.title,
        amount: input.amount ?? DEFAULT_MONEY_AMOUNT,
        currency: input.currency,
        expectedCloseDate: input.expectedCloseDate ? dateOnlyToDate(input.expectedCloseDate) : null,
      },
      input.actorId,
    );
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateDealDto): Promise<DealResponseDto> {
    assertHasChanges(dto);
    const scope = await this.ownership.resolve(actor);
    const { ownerId, contactId, companyId, expectedCloseDate, ...fields } = dto;
    const changes: DealChanges = fields;
    if (expectedCloseDate !== undefined) {
      changes.expectedCloseDate = expectedCloseDate ? dateOnlyToDate(expectedCloseDate) : null;
    }

    // Unlinking (`null`) is always allowed and needs no check or lock.
    if (contactId === null) changes.contactId = null;
    if (companyId === null) changes.companyId = null;

    const needsCurrent =
      ownerId !== undefined || contactId || companyId || dto.amount !== undefined || dto.currency;
    const current = needsCurrent ? await this.repository.findVisible(scope, id) : undefined;
    if (current === null) throw resourceNotFound('Deal');
    // Say "closed" before judging the new owner or links: the deal is read-only whoever gets it.
    if (current && current.status !== DealStatus.OPEN) throw new DealClosedException();

    if (current && ownerId !== undefined) {
      changes.ownerId = await ownerForTransfer(this.ownership, scope, ownerId, current.ownerId);
    }
    // Only a link the deal does not already have is checked and locked (shared). An unchanged one
    // stays as is, so a deal can still be edited after its company moved to someone else.
    const newCompanyId = companyId && companyId !== current?.companyId ? companyId : undefined;
    const newContactId = contactId && contactId !== current?.contactId ? contactId : undefined;
    if (newCompanyId) changes.companyId = newCompanyId;
    if (newContactId) changes.contactId = newContactId;

    const updated =
      newCompanyId || newContactId
        ? await this.repository.inLocks(
            sharedLocks(undefined, newCompanyId, newContactId),
            async (tx) => {
              await this.assertPartiesLinkable(tx, scope, newCompanyId, newContactId);
              return this.repository.updateOpenVisible(scope, id, changes, tx);
            },
          )
        : await this.repository.updateOpenVisible(scope, id, changes);
    if (!updated) throw await this.whyNotEditable(scope, id);

    if (current) this.logMoneyChange(actor, current, updated);
    return toDealResponse(updated);
  }

  // Moves the deal to another stage of ITS pipeline; the status follows the stage (deal-move.ts).
  // The transition is the shared compare-and-set: the deal is read with the caller's visibility, and
  // the write only matches while it is still in the stage that was read, so two moves racing each
  // other cannot both win (the loser gets DEAL_STAGE_CHANGED). The write runs under the SHARED
  // pipeline lock, so a stage delete waits for it and a move waits for a stage delete.
  async move(actor: AuthenticatedUser, id: string, dto: MoveDealDto): Promise<DealResponseDto> {
    const scope = await this.ownership.resolve(actor);
    // Filled by the callbacks below (a holder object, because the compiler cannot see closures write).
    const seen: { deal: DealRecord | null; from: string | null } = { deal: null, from: null };
    const changedAt = new Date();

    const moved = await applyStatusTransition({
      map: (from: string, to: string) => from !== to,
      to: dto.stageId,
      read: async () => {
        seen.deal = await this.repository.findVisible(scope, id);
        return seen.deal && { status: seen.deal.stageId };
      },
      write: (from) => {
        seen.from = from;
        // The pipeline of a deal never changes, so the one read above names the right lock.
        const pipelineId = seen.deal?.pipelineId ?? id;
        return this.repository.inLocks(
          [{ kind: 'pipeline', id: pipelineId, mode: 'shared' }],
          async (tx) => {
            const stage = await this.pipelines.findStageInPipeline(tx, pipelineId, dto.stageId);
            const outcome = outcomeOfMove(stage, dto.lostReason, changedAt);
            const result = await this.repository.moveStage(tx, scope, id, from, {
              stageId: stage.id,
              ...outcome,
            });
            // The history row exists only if the move did: it is written in this same transaction,
            // after the compare-and-set matched.
            if (result) {
              await this.repository.recordStageChange(tx, {
                organizationId: actor.organizationId,
                dealId: id,
                fromStageId: from,
                toStageId: stage.id,
                changedById: actor.userId,
              });
            }
            return result;
          },
        );
      },
      notFound: () => resourceNotFound('Deal'),
      rejected: () => new InvalidStageMoveException(),
      changedConcurrently: () => new DealStageChangedException(),
    });

    publishDomainEvent(
      this.events,
      this.logger,
      DEAL_STAGE_CHANGED_EVENT,
      {
        organizationId: actor.organizationId,
        dealId: moved.id,
        pipelineId: moved.pipelineId,
        fromStageId: seen.from ?? moved.stageId,
        toStageId: moved.stageId,
        status: moved.status,
        actorId: actor.userId,
        changedAt,
      } satisfies DealStageChangedEvent,
      `deal ${moved.id}`,
    );
    return toDealResponse(moved);
  }

  // Follows the deal's visibility: a deal the caller cannot see has no readable history (404).
  async history(
    actor: AuthenticatedUser,
    id: string,
    query: ListDealHistoryQueryDto,
  ): Promise<PaginatedResponseDto<DealHistoryResponseDto>> {
    const scope = await this.ownership.resolve(actor);
    if (!(await this.repository.findVisible(scope, id))) throw resourceNotFound('Deal');
    return this.repository.findHistoryPage(id, query);
  }

  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    const deleted = await this.repository.deleteVisible(await this.ownership.resolve(actor), id);
    if (!deleted) throw resourceNotFound('Deal');
  }

  private async assertPartiesLinkable(
    tx: DealsTx,
    scope: VisibilityScope,
    companyId: string | null | undefined,
    contactId: string | null | undefined,
  ): Promise<void> {
    if (companyId) await this.companies.assertLinkable(tx, scope, companyId);
    if (contactId) await this.contacts.assertLinkable(tx, scope, contactId);
  }

  // An update matched nothing. Look again WITH the caller's visibility: a deal they can see that is
  // no longer OPEN answers 409; everything else (missing, deleted, other tenant, not theirs,
  // reassigned away) is the one 404, so a hidden closed deal is never revealed.
  private async whyNotEditable(scope: VisibilityScope, id: string): Promise<Error> {
    const deal = await this.repository.findVisible(scope, id);
    return deal && deal.status !== DealStatus.OPEN
      ? new DealClosedException()
      : resourceNotFound('Deal');
  }

  // Amount and currency changes are not audited yet (Phase 13 adds the audit log): until then a
  // structured log keeps who changed what, from which value to which. Ids and values only.
  private logMoneyChange(actor: AuthenticatedUser, before: DealRecord, after: DealRecord): void {
    const amountChanged = !before.amount.equals(after.amount);
    const currencyChanged = before.currency !== after.currency;
    if (!amountChanged && !currencyChanged) return;
    this.logger.log({
      event: 'deal.money_changed',
      organizationId: actor.organizationId,
      dealId: after.id,
      actorId: actor.userId,
      ...(amountChanged && {
        amount: { from: before.amount.toFixed(2), to: after.amount.toFixed(2) },
      }),
      ...(currencyChanged && { currency: { from: before.currency, to: after.currency } }),
    });
  }
}

// Shared locks in the order pipeline -> company -> contact; absent ids are skipped.
function sharedLocks(
  pipelineId: string | undefined,
  companyId: string | null | undefined,
  contactId: string | null | undefined,
): LockRequest[] {
  return [
    ...(pipelineId ? [{ kind: 'pipeline' as const, id: pipelineId, mode: 'shared' as const }] : []),
    ...(companyId ? [{ kind: 'company' as const, id: companyId, mode: 'shared' as const }] : []),
    ...(contactId ? [{ kind: 'contact' as const, id: contactId, mode: 'shared' as const }] : []),
  ];
}
