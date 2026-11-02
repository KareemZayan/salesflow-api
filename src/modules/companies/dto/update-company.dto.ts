import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import {
  HOSTNAME_PATTERN,
  PHONE_MAX_LENGTH,
  PHONE_PATTERN,
} from '../../../common/policies/contact-details-policy';
import { trimString, trimToNull } from '../../../common/utils/string-transform.util';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import {
  COMPANY_ADDRESS_MAX_LENGTH,
  COMPANY_DOMAIN_MAX_LENGTH,
  COMPANY_INDUSTRY_MAX_LENGTH,
  COMPANY_NAME_MAX_LENGTH,
} from '../companies.constants';
import { normalizeDomain } from './create-company.dto';

// `name` and `ownerId` are NOT NULL columns (OptionalButNotNull); the other fields may be cleared
// by sending `null` or a blank string (IsOptional lets null through).
export class UpdateCompanyDto {
  @ApiPropertyOptional({ maxLength: COMPANY_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(COMPANY_NAME_MAX_LENGTH)
  @OptionalButNotNull()
  name?: string;

  @ApiPropertyOptional({ example: 'acme.com', nullable: true, type: String })
  @Transform(normalizeDomain)
  @Matches(HOSTNAME_PATTERN, { message: 'domain must be a bare hostname such as acme.com' })
  @MaxLength(COMPANY_DOMAIN_MAX_LENGTH)
  @IsOptional()
  domain?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: COMPANY_INDUSTRY_MAX_LENGTH })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(COMPANY_INDUSTRY_MAX_LENGTH)
  @IsOptional()
  industry?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @Transform(trimToNull)
  @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  @MaxLength(PHONE_MAX_LENGTH)
  @IsOptional()
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: COMPANY_ADDRESS_MAX_LENGTH })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(COMPANY_ADDRESS_MAX_LENGTH)
  @IsOptional()
  address?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Transferring ownership needs a manager (for their team) or an admin',
  })
  @IsUUID()
  @OptionalButNotNull()
  ownerId?: string;
}
