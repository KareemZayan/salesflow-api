import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsUUID, ValidateNested } from 'class-validator';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import { ConvertDealDto } from './convert-deal.dto';

// Every field is optional: an empty body creates a new contact from the lead's own data.
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

  @ApiPropertyOptional({
    type: ConvertDealDto,
    description:
      'Also create a deal in the same transaction (needs deals:create). It is linked to the ' +
      'contact and its company, owned by the lead owner, and placed like POST /deals (default ' +
      'pipeline and first open stage unless told otherwise). An invalid pipeline or stage rolls ' +
      'the whole conversion back.',
  })
  @OptionalButNotNull()
  @ValidateNested()
  @Type(() => ConvertDealDto)
  deal?: ConvertDealDto;
}
