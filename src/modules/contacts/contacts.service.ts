import { Injectable } from '@nestjs/common';
import { PaginatedResponseDto } from '../../common/dto/paginated-response.dto';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { assertHasChanges } from '../../common/utils/assert-has-changes.util';
import { ownerForCreate, ownerForTransfer } from '../../common/visibility/owner-assignment';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { VisibilityScope } from '../../common/visibility/visibility.types';
import { CompaniesService } from '../companies/companies.service';
import {
  CompanyLink,
  ContactChanges,
  ContactRecord,
  ContactsRepository,
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
    const deleted = await this.repository.deleteVisible(await this.ownership.resolve(actor), id);
    if (!deleted) throw resourceNotFound('Contact');
  }

  private linkTo(scope: VisibilityScope, companyId: string): CompanyLink {
    return { companyId, verify: (db) => this.companies.assertLinkable(db, scope, companyId) };
  }
}
