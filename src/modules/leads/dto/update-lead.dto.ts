import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { PHONE_MAX_LENGTH, PHONE_PATTERN } from '../../../common/policies/contact-details-policy';
import {
  trimLowerToNull,
  trimString,
  trimToNull,
} from '../../../common/utils/string-transform.util';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import { LeadSource } from '../../../generated/prisma/client';
import {
  LEAD_COMPANY_NAME_MAX_LENGTH,
  LEAD_EMAIL_MAX_LENGTH,
  LEAD_NAME_MAX_LENGTH,
  LEAD_NOTES_MAX_LENGTH,
} from '../leads.constants';

// `firstName`, `lastName`, `source` and `ownerId` are NOT NULL columns (OptionalButNotNull); the
// other fields may be cleared with `null` (or a blank string). No `score`, `status` or conversion
// field exists here on purpose (see CreateLeadDto).
export class UpdateLeadDto {
  @ApiPropertyOptional({ maxLength: LEAD_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LEAD_NAME_MAX_LENGTH)
  @OptionalButNotNull()
  firstName?: string;

  @ApiPropertyOptional({ maxLength: LEAD_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LEAD_NAME_MAX_LENGTH)
  @OptionalButNotNull()
  lastName?: string;

  @ApiPropertyOptional({ enum: LeadSource, description: 'Changing it recomputes the score.' })
  @IsEnum(LeadSource)
  @OptionalButNotNull()
  source?: LeadSource;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'omar@globex.com' })
  @Transform(trimLowerToNull)
  @IsEmail()
  @MaxLength(LEAD_EMAIL_MAX_LENGTH)
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @Transform(trimToNull)
  @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  @MaxLength(PHONE_MAX_LENGTH)
  @IsOptional()
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: LEAD_COMPANY_NAME_MAX_LENGTH })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(LEAD_COMPANY_NAME_MAX_LENGTH)
  @IsOptional()
  companyName?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: LEAD_NOTES_MAX_LENGTH })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(LEAD_NOTES_MAX_LENGTH)
  @IsOptional()
  notes?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Transferring ownership needs a manager (for their team) or an admin',
  })
  @IsUUID()
  @OptionalButNotNull()
  ownerId?: string;
}
