import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { DomainException } from '../../common/exceptions/domain.exception';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { assertHasChanges } from '../../common/utils/assert-has-changes.util';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { CompaniesRepository, CompanyChanges, CompanyRecord } from './companies.repository';
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

  async create(actor: AuthenticatedUser, dto: CreateCompanyDto): Promise<CompanyRecord> {
    const { ownerId, ...fields } = dto;
    const owner =
      ownerId && ownerId !== actor.userId
        ? await this.ownership.resolveAssignableOwner(await this.ownership.resolve(actor), ownerId)
        : actor.userId;
    return this.repository.create({
      ...fields,
      organizationId: actor.organizationId,
      ownerId: owner,
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
      // Only a real transfer is checked and written. An unchanged owner stays as is, so a manager
      // can edit a company whose owner has since been deactivated.
      if (ownerId !== current.ownerId) {
        changes.ownerId = await this.ownership.resolveAssignableOwner(scope, ownerId);
      }
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
    return new DomainException(
      ERROR_CODES.RESOURCE_NOT_FOUND,
      'Company not found',
      HttpStatus.NOT_FOUND,
    );
  }
}
