import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';
import { resourceNotFound } from '../../common/exceptions/resource-not-found';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { applyStatusTransition } from '../../common/utils/status-transition.util';
import { ownerForCreate } from '../../common/visibility/owner-assignment';
import { OwnershipScopeService } from '../../common/visibility/ownership-scope.service';
import { LeadStatus } from '../../generated/prisma/client';
import { CompaniesService } from '../companies/companies.service';
import { CompanyResponseDto } from '../companies/dto/company-response.dto';
import { ContactResponseDto } from '../contacts/dto/contact-response.dto';
import { ContactsService } from '../contacts/contacts.service';
import { ConvertLeadDto } from './dto/convert-lead.dto';
import { ConvertLeadResponseDto } from './dto/convert-lead-response.dto';
import { LEAD_CONVERSION_TRANSITIONS } from './lead-conversion-transitions';
import { LEAD_CONVERTED_EVENT, LeadConvertedEvent } from './events/lead-converted.event';
import {
  InvalidConversionOptionsException,
  concurrentLeadStatusChange,
  rejectedLeadConversion,
} from './leads.exceptions';
import { ConversionLock, LeadsRepository } from './leads.repository';

interface ConversionOutcome {
  contactId: string;
  contact: ContactResponseDto;
  createdCompany: CompanyResponseDto | null;
}

// Orchestrates the cross-module part of a conversion; the transaction itself, the locks and the
// claim live in LeadsRepository.convert. Other modules are reached through their services only.
@Injectable()
export class LeadConversionService {
  private readonly logger = new Logger(LeadConversionService.name);

  constructor(
    private readonly repository: LeadsRepository,
    private readonly ownership: OwnershipScopeService,
    private readonly contacts: ContactsService,
    private readonly companies: CompaniesService,
    private readonly events: EventEmitter2,
  ) {}

  async convert(
    actor: AuthenticatedUser,
    id: string,
    dto: ConvertLeadDto,
  ): Promise<ConvertLeadResponseDto> {
    this.assertCompatibleOptions(dto);
    this.assertMayCreate(actor, dto);
    const scope = await this.ownership.resolve(actor);

    const converted = await applyStatusTransition({
      map: LEAD_CONVERSION_TRANSITIONS,
      to: LeadStatus.CONVERTED,
      read: () => this.repository.findVisible(scope, id),
      write: (from) =>
        this.repository.convert<ConversionOutcome>(
          scope,
          id,
          from,
          this.lockFor(dto),
          async (tx, lead) => {
            // Linking an existing contact: it is checked under its lock and never modified.
            if (dto.contactId) {
              const contact = await this.contacts.assertLinkable(tx, scope, dto.contactId);
              return { contactId: contact.id, contact, createdCompany: null };
            }

            if (dto.createCompany && !lead.companyName) {
              throw new InvalidConversionOptionsException(
                'createCompany needs the lead to have a company name',
              );
            }
            if (dto.companyId) await this.companies.assertLinkable(tx, scope, dto.companyId);

            // The new records belong to the lead's owner, not to whoever clicks "convert".
            const ownerId = await ownerForCreate(this.ownership, actor, lead.ownerId);
            const createdCompany =
              dto.createCompany && lead.companyName
                ? await this.companies.createWithin(tx, {
                    organizationId: actor.organizationId,
                    ownerId,
                    name: lead.companyName,
                  })
                : null;
            const contact = await this.contacts.createWithin(tx, {
              organizationId: actor.organizationId,
              ownerId,
              companyId: createdCompany?.id ?? dto.companyId,
              firstName: lead.firstName,
              lastName: lead.lastName,
              email: lead.email,
              phone: lead.phone,
            });
            return { contactId: contact.id, contact, createdCompany };
          },
        ),
      notFound: () => resourceNotFound('Lead'),
      rejected: (from) => rejectedLeadConversion(from),
      changedConcurrently: concurrentLeadStatusChange,
    });

    const { lead, outcome } = converted;
    this.publish({
      organizationId: actor.organizationId,
      leadId: lead.id,
      contactId: outcome.contactId,
      companyId: outcome.contact.companyId,
      dealId: null,
      ownerId: lead.ownerId,
      actorId: actor.userId,
      // convertedAt is set in the same statement that sets CONVERTED, so it is never null here.
      convertedAt: lead.convertedAt ?? new Date(),
    });
    return { lead, contact: outcome.contact, createdCompany: outcome.createdCompany };
  }

  // Options that contradict each other are a 400, not "the body wins": an existing contact already
  // has its company, and a company is either linked or created.
  private assertCompatibleOptions({ contactId, companyId, createCompany }: ConvertLeadDto): void {
    if (contactId && (companyId || createCompany)) {
      throw new InvalidConversionOptionsException(
        'contactId cannot be combined with companyId or createCompany: an existing contact is linked as it is',
      );
    }
    if (companyId && createCompany) {
      throw new InvalidConversionOptionsException(
        'companyId and createCompany cannot be combined: link an existing company or create one',
      );
    }
  }

  // The permission follows what really happens: leads:convert (the route) always; contacts:create
  // only when a contact is created; companies:create only when a company is created.
  private assertMayCreate(actor: AuthenticatedUser, dto: ConvertLeadDto): void {
    const needed = [
      ...(dto.contactId ? [] : ['contacts:create']),
      ...(dto.createCompany ? ['companies:create'] : []),
    ];
    if (needed.every((permission) => actor.permissions.includes(permission))) return;
    throw new DomainException(
      ERROR_CODES.FORBIDDEN,
      'You do not have permission to perform this action',
      HttpStatus.FORBIDDEN,
    );
  }

  private lockFor({ contactId, companyId }: ConvertLeadDto): ConversionLock | undefined {
    if (contactId) return { kind: 'contact', id: contactId };
    if (companyId) return { kind: 'company', id: companyId };
    return undefined;
  }

  // Fire and forget, after the commit. A listener that throws (synchronously or by rejecting) is
  // logged and never reaches the caller: the conversion already happened.
  private publish(event: LeadConvertedEvent): void {
    const failed = (error: unknown) =>
      this.logger.error(
        `A ${LEAD_CONVERTED_EVENT} listener failed (lead ${event.leadId}): ${String(error)}`,
      );
    try {
      this.events.emitAsync(LEAD_CONVERTED_EVENT, event).catch(failed);
    } catch (error) {
      failed(error);
    }
  }
}
