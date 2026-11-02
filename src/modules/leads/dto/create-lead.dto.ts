import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
import { LeadSource } from '../../../generated/prisma/client';
import {
  LEAD_COMPANY_NAME_MAX_LENGTH,
  LEAD_EMAIL_MAX_LENGTH,
  LEAD_NAME_MAX_LENGTH,
  LEAD_NOTES_MAX_LENGTH,
} from '../leads.constants';

// There is deliberately no `score`, `status` or conversion field: the server computes the score,
// and status/conversion have their own rules (forbidNonWhitelisted answers 400 if they are sent).
export class CreateLeadDto {
  @ApiProperty({ example: 'Omar', maxLength: LEAD_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LEAD_NAME_MAX_LENGTH)
  firstName!: string;

  @ApiProperty({ example: 'Khaled', maxLength: LEAD_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(LEAD_NAME_MAX_LENGTH)
  lastName!: string;

  @ApiProperty({ enum: LeadSource, example: LeadSource.WEBSITE })
  @IsEnum(LeadSource)
  source!: LeadSource;

  @ApiPropertyOptional({
    example: 'omar@globex.com',
    description: 'Optional. Trimmed and stored lowercase. Not unique: duplicates are allowed.',
  })
  @Transform(trimLowerToNull)
  @IsEmail()
  @MaxLength(LEAD_EMAIL_MAX_LENGTH)
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({ example: '+20 100 123 4567' })
  @Transform(trimToNull)
  @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  @MaxLength(PHONE_MAX_LENGTH)
  @IsOptional()
  phone?: string | null;

  @ApiPropertyOptional({
    example: 'Globex',
    maxLength: LEAD_COMPANY_NAME_MAX_LENGTH,
    description: 'Free text; a company record is only created when the lead is converted.',
  })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(LEAD_COMPANY_NAME_MAX_LENGTH)
  @IsOptional()
  companyName?: string | null;

  @ApiPropertyOptional({ maxLength: LEAD_NOTES_MAX_LENGTH })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(LEAD_NOTES_MAX_LENGTH)
  @IsOptional()
  notes?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Defaults to you. A rep can only name themselves; a manager their team.',
  })
  @IsUUID()
  @IsOptional()
  ownerId?: string;
}
