import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsUUID } from 'class-validator';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';

// Every field is optional: an empty body creates a new contact from the lead's own data. There is
// deliberately no `deal` field yet (Phase 10): sending one is rejected as an unknown property.
export class ConvertLeadDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Link an existing contact instead of creating one. The contact is never modified. ' +
      'Cannot be combined with `companyId` or `createCompany`.',
  })
  @OptionalButNotNull()
  @IsUUID()
  contactId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Put the NEW contact under this existing company. Cannot be combined with `createCompany`.',
  })
  @OptionalButNotNull()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({
    description:
      'Create a company named after the lead `companyName` and put the new contact under it. ' +
      'The lead must have a company name. Without this flag or `companyId`, the lead company ' +
      'name (free text) is not turned into a company.',
  })
  @OptionalButNotNull()
  @IsBoolean()
  createCompany?: boolean;
}
