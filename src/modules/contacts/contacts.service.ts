import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { DomainException } from '../../common/exceptions/domain.exception';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { assertHasChanges } from '../../common/utils/assert-has-changes.util';
import { ownerForCreate, ownerForTransfer } from '../../common/visibility/owner-assignment';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { TenantTransactionClient } from '../../common/tenant/tenant-scope.extension';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { CompaniesService } from '../companies/companies.service';
import {
  CompanyLink,
  ContactChanges,
  ContactRecord,
  ContactsRepository,
  NewContactData,
} from './contacts.repository';
import { CreateContactDto } from './dto/create-contact.dto';
import { ListContactsQueryDto } from './dto/list-contacts-query.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@Injectable()
export class ContactsService {
  constructor(
    private readonly repository: ContactsRepository,
    private readonly ownership: OwnershipScopeService,
    private readonly companies: CompaniesService,
  ) {}

  async list(
    actor: AuthenticatedUser,
    query: ListContactsQueryDto,
  ): Promise<PaginatedResponseDto<ContactRecord>> {
    return this.repository.findPage(await this.ownership.resolve(actor), query);
  }

  async get(actor: AuthenticatedUser, id: string): Promise<ContactRecord> {
    const contact = await this.repository.findVisible(await this.ownership.resolve(actor), id);
    if (!contact) throw resourceNotFound('Contact');
    return contact;
  }

  // For lead conversion. Call it INSIDE the transaction that holds the 'contact' lock and writes the
  // link: the contact cannot then be deleted between this check and the write. Missing, deleted,
  // foreign and not-visible contacts all give the same 400.
  async assertLinkable(
    db: Pick<TenantTransactionClient, 'contact'>,
    scope: VisibilityScope,
    contactId: string,
  ): Promise<ContactRecord> {
    const contact = await this.repository.findVisible(scope, contactId, db);
    if (contact) return contact;
    throw new DomainException(
      ERROR_CODES.INVALID_CONTACT,
      'The contact must be one you are allowed to link',
      HttpStatus.BAD_REQUEST,
    );
  }

  // Creates a contact inside the caller's transaction (lead conversion).
  createWithin(
    db: Pick<TenantTransactionClient, 'contact'>,
    data: NewContactData,
  ): Promise<ContactRecord> {
    return this.repository.createWithin(db, data);
  }

  async create(actor: AuthenticatedUser, dto: CreateContactDto): Promise<ContactRecord> {
    const { ownerId, companyId, ...fields } = dto;
    const link = companyId
      ? this.linkTo(await this.ownership.resolve(actor), companyId)
      : undefined;
    return this.repository.create(
      {
        ...fields,
        companyId,
        organizationId: actor.organizationId,
        ownerId: await ownerForCreate(this.ownership, actor, ownerId),
      },
      link,
    );
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateContactDto,
  ): Promise<ContactRecord> {
    assertHasChanges(dto);
    const scope = await this.ownership.resolve(actor);
    const { ownerId, companyId, ...fields } = dto;
    const changes: ContactChanges = fields;
    let link: CompanyLink | undefined;

    // Unlinking (`null`) is always allowed and needs no check or lock.
    if (companyId === null) changes.companyId = null;

    if (ownerId !== undefined || companyId) {
      const current = await this.repository.findVisible(scope, id);
      if (!current) throw resourceNotFound('Contact');
      if (ownerId !== undefined) {
        changes.ownerId = await ownerForTransfer(this.ownership, scope, ownerId, current.ownerId);
      }
      // Only a company the contact does not already have is checked and locked. An unchanged
      // companyId stays as is, so a rep can still edit a contact whose company has since moved to
      // someone else.
      if (companyId && companyId !== current.companyId) {
        changes.companyId = companyId;
        link = this.linkTo(scope, companyId);
      }
    }

    // The write carries the visibility filter itself: if the contact was reassigned away from the
    // caller after the read above, it matches nothing and the answer is the same 404.
    const updated = await this.repository.updateVisible(scope, id, changes, link);
    if (!updated) throw resourceNotFound('Contact');
    return updated;
  }

  async delete(actor: AuthenticatedUser, id: string): Promise<void> {
    const outcome = await this.repository.softDeleteIfUnused(
      await this.ownership.resolve(actor),
      id,
    );
    if (outcome === 'not-found') throw resourceNotFound('Contact');
    if (outcome === 'has-open-deals') {
      // No count and no owners: the message must not describe records the caller cannot see.
      throw new DomainException(
        ERROR_CODES.CONTACT_HAS_OPEN_DEALS,
        'Contact has open deals and cannot be deleted',
        HttpStatus.CONFLICT,
      );
    }
  }

  private linkTo(scope: VisibilityScope, companyId: string): CompanyLink {
    return { companyId, verify: (db) => this.companies.assertLinkable(db, scope, companyId) };
  }
}
