import { Inject, Injectable } from '@nestjs/common';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { assertHasChanges } from '../../common/utils/assert-has-changes.util';
import { ownerForCreate, ownerForTransfer } from '../../common/visibility/owner-assignment';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadChanges, LeadRecord, LeadsRepository, Rescore } from './leads.repository';
import {
  LEAD_SCORING_STRATEGY,
  LeadScoringInput,
  LeadScoringStrategy,
  SCORING_FIELDS,
} from './scoring/lead-scoring.strategy';

@Injectable()
export class LeadsService {
  constructor(
    private readonly repository: LeadsRepository,
    private readonly ownership: OwnershipScopeService,
    @Inject(LEAD_SCORING_STRATEGY) private readonly scoring: LeadScoringStrategy,
  ) {}

  async list(
    actor: AuthenticatedUser,
    query: ListLeadsQueryDto,
  ): Promise<PaginatedResponseDto<LeadRecord>> {
    return this.repository.findPage(await this.ownership.resolve(actor), query);
  }

  async get(actor: AuthenticatedUser, id: string): Promise<LeadRecord> {
    const lead = await this.repository.findVisible(await this.ownership.resolve(actor), id);
    if (!lead) throw resourceNotFound('Lead');
    return lead;
  }

  async create(actor: AuthenticatedUser, dto: CreateLeadDto): Promise<LeadRecord> {
    const { ownerId, ...fields } = dto;
    return this.repository.create({
      ...fields,
      // Every lead has an owner (ownerId is NOT NULL, ADR 0008): the caller unless they assign it.
      ownerId: await ownerForCreate(this.ownership, actor, ownerId),
      organizationId: actor.organizationId,
      score: this.scoring.score({
        source: dto.source,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        companyName: dto.companyName ?? null,
      }),
    });
  }

  async update(actor: AuthenticatedUser, id: string, dto: UpdateLeadDto): Promise<LeadRecord> {
    assertHasChanges(dto);
    const scope = await this.ownership.resolve(actor);
    const { ownerId, ...fields } = dto;
    const changes: LeadChanges = fields;

    if (ownerId !== undefined) {
      const current = await this.repository.findVisible(scope, id);
      if (!current) throw resourceNotFound('Lead');
      changes.ownerId = await ownerForTransfer(this.ownership, scope, ownerId, current.ownerId);
    }

    // The write carries the visibility filter itself: if the lead was reassigned away from the
    // caller after the read above, it matches nothing and the answer is the same 404.
    const updated = await this.repository.updateVisible(scope, id, changes, this.rescoreFor(dto));
    if (!updated) throw resourceNotFound('Lead');
    return updated;
  }

  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    const deleted = await this.repository.deleteVisible(await this.ownership.resolve(actor), id);
    if (!deleted) throw resourceNotFound('Lead');
  }

  // Only a change to a scoring field needs a new score (and, in the repository, the lead lock):
  // owner, name and notes changes leave the score alone.
  private rescoreFor(dto: UpdateLeadDto): Rescore | undefined {
    const scoringChanges: Partial<LeadScoringInput> = {};
    for (const field of SCORING_FIELDS) {
      if (dto[field] !== undefined) Object.assign(scoringChanges, { [field]: dto[field] });
    }
    if (Object.keys(scoringChanges).length === 0) return undefined;
    return (current) => this.scoring.score({ ...current, ...scoringChanges });
  }
}
