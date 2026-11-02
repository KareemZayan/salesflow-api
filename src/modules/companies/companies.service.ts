import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { DomainException } from '../../common/exceptions/domain.exception';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { assertHasChanges } from '../../common/utils/assert-has-changes.util';
import { ownerForCreate, ownerForTransfer } from '../../common/visibility/owner-assignment';
import { TenantTransactionClient } from '../../common/tenant/tenant-scope.extension';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import {
  CompaniesRepository,
  CompanyChanges,
  CompanyRecord,
  NewCompanyData,
} from './companies.repository';
import { CreateCompanyDto } from './dto/create-company.dto';
import { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';

@Injectable()
export class CompaniesService {
  constructor(
    private readonly repository: CompaniesRepository,
    private readonly ownership: OwnershipScopeService,
  ) {}

  async list(
    actor: AuthenticatedUser,
    query: ListCompaniesQueryDto,
  ): Promise<PaginatedResponseDto<CompanyRecord>> {
    return this.repository.findPage(await this.ownership.resolve(actor), query);
  }

  async get(actor: AuthenticatedUser, id: string): Promise<CompanyRecord> {
    const company = await this.repository.findVisible(await this.ownership.resolve(actor), id);
    if (!company) throw this.notFound();
    return company;
  }

  // For modules that link their records to a company (contacts). Call it INSIDE the transaction that
  // holds the 'company' lock and performs the link: the company cannot then be deleted between this
  // check and the write, because the delete waits for the same lock and counts afterwards.
  // Missing, deleted, foreign and not-visible companies all give the same 400.
  async assertLinkable(
    db: Pick<TenantTransactionClient, 'company'>,
    scope: VisibilityScope,
    companyId: string,
  ): Promise<void> {
    if (await this.repository.findVisible(scope, companyId, db)) return;
    throw new DomainException(
      ERROR_CODES.INVALID_COMPANY,
      'The company must be one you are allowed to link contacts to',
      HttpStatus.BAD_REQUEST,
    );
  }

  // Creates a company inside the caller's transaction (lead conversion).
  createWithin(
    db: Pick<TenantTransactionClient, 'company'>,
    data: NewCompanyData,
  ): Promise<CompanyRecord> {
    return this.repository.createWithin(db, data);
  }

  async create(actor: AuthenticatedUser, dto: CreateCompanyDto): Promise<CompanyRecord> {
    const { ownerId, ...fields } = dto;
    return this.repository.create({
      ...fields,
      organizationId: actor.organizationId,
      ownerId: await ownerForCreate(this.ownership, actor, ownerId),
    });
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateCompanyDto,
  ): Promise<CompanyRecord> {
    assertHasChanges(dto);
    const scope = await this.ownership.resolve(actor);
    const { ownerId, ...fields } = dto;
    const changes: CompanyChanges = fields;

    if (ownerId !== undefined) {
      const current = await this.repository.findVisible(scope, id);
      if (!current) throw this.notFound();
      changes.ownerId = await ownerForTransfer(this.ownership, scope, ownerId, current.ownerId);
    }

    // The write carries the visibility filter itself: if the company was reassigned away from the
    // caller after the read above, it matches nothing and the answer is the same 404.
    const updated = await this.repository.updateVisible(scope, id, changes);
    if (!updated) throw this.notFound();
    return updated;
  }

  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    const outcome = await this.repository.softDeleteIfUnused(
      await this.ownership.resolve(actor),
      id,
    );
    if (outcome === 'not-found') throw this.notFound();
    if (outcome === 'has-contacts') {
      // No count and no owners: the message must not describe records the caller cannot see.
      throw new DomainException(
        ERROR_CODES.COMPANY_HAS_CONTACTS,
        'Company has contacts and cannot be deleted',
        HttpStatus.CONFLICT,
      );
    }
  }

  private notFound(): DomainException {
    return resourceNotFound('Company');
  }
}
