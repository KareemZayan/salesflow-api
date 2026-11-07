import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { AuditService } from '../audit-logs/audit.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationRecord, OrganizationsRepository } from './organizations.repository';

const auditedOf = ({ name, defaultCurrency }: OrganizationRecord) => ({ name, defaultCurrency });

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly repository: OrganizationsRepository,
    private readonly audit: AuditService,
  ) {}

  async getCurrent(actor: AuthenticatedUser): Promise<OrganizationRecord> {
    return this.orFail(await this.repository.findById(actor.organizationId));
  }

  async updateCurrent(
    actor: AuthenticatedUser,
    { name, defaultCurrency }: UpdateOrganizationDto,
  ): Promise<OrganizationRecord> {
    if (name === undefined && defaultCurrency === undefined) {
      throw new DomainException(
        ERROR_CODES.BAD_REQUEST,
        'Provide at least one field to update: name or defaultCurrency',
        HttpStatus.BAD_REQUEST,
      );
    }
    const id = actor.organizationId;
    return this.orFail(
      await this.repository.withOrgLock(id, async (tx) => {
        const before = await this.repository.findById(id, tx);
        const after = await this.repository.update(id, { name, defaultCurrency }, tx);
        if (before && after) {
          await this.audit.record(tx, {
            event: 'organization.updated',
            entityId: id,
            before: auditedOf(before),
            after: auditedOf(after),
          });
        }
        return after;
      }),
    );
  }

  private orFail(record: OrganizationRecord | null): OrganizationRecord {
    if (!record) {
      throw new DomainException(
        ERROR_CODES.RESOURCE_NOT_FOUND,
        'Organization not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return record;
  }
}
