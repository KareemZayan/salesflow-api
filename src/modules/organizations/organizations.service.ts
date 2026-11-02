import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { DomainException } from '../../common/exceptions/domain.exception';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationRecord, OrganizationsRepository } from './organizations.repository';

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(private readonly repository: OrganizationsRepository) {}

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
    const updated = this.orFail(
      await this.repository.update(actor.organizationId, { name, defaultCurrency }),
    );
    this.logger.log({
      event: 'organization.updated',
      organizationId: actor.organizationId,
      actorId: actor.userId,
      fields: [
        name !== undefined && 'name',
        defaultCurrency !== undefined && 'defaultCurrency',
      ].filter(Boolean),
    });
    return updated;
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
