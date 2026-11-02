import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import {
  HOSTNAME_PATTERN,
  PHONE_MAX_LENGTH,
  PHONE_PATTERN,
} from '../../../common/policies/contact-details-policy';
import {
  trimLowerToNull,
  trimString,
  trimToNull,
} from '../../../common/utils/string-transform.util';
import {
  COMPANY_ADDRESS_MAX_LENGTH,
  COMPANY_DOMAIN_MAX_LENGTH,
  COMPANY_INDUSTRY_MAX_LENGTH,
  COMPANY_NAME_MAX_LENGTH,
} from '../companies.constants';

export class CreateCompanyDto {
  @ApiProperty({ example: 'Acme Ltd', maxLength: COMPANY_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(COMPANY_NAME_MAX_LENGTH)
  name!: string;

  @ApiPropertyOptional({
    example: 'acme.com',
    description: 'Bare hostname, stored lowercase. URLs (scheme/path) are rejected.',
  })
  // Domains are stored as bare lowercase hostnames. A pasted URL is rejected (400) instead of being
  // silently rewritten, so what the client sent is what is stored.
  @Transform(trimLowerToNull)
  @Matches(HOSTNAME_PATTERN, { message: 'domain must be a bare hostname such as acme.com' })
  @MaxLength(COMPANY_DOMAIN_MAX_LENGTH)
  @IsOptional()
  domain?: string | null;

  @ApiPropertyOptional({ example: 'Software', maxLength: COMPANY_INDUSTRY_MAX_LENGTH })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(COMPANY_INDUSTRY_MAX_LENGTH)
  @IsOptional()
  industry?: string | null;

  @ApiPropertyOptional({ example: '+20 100 123 4567' })
  @Transform(trimToNull)
  @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  @MaxLength(PHONE_MAX_LENGTH)
  @IsOptional()
  phone?: string | null;

  @ApiPropertyOptional({ maxLength: COMPANY_ADDRESS_MAX_LENGTH })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(COMPANY_ADDRESS_MAX_LENGTH)
  @IsOptional()
  address?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Defaults to you. A rep can only name themselves; a manager their team.',
  })
  @IsUUID()
  @IsOptional()
  ownerId?: string;
}
