import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
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
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_JOB_TITLE_MAX_LENGTH,
  CONTACT_NAME_MAX_LENGTH,
} from '../contacts.constants';

export class CreateContactDto {
  @ApiProperty({ example: 'Sara', maxLength: CONTACT_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTACT_NAME_MAX_LENGTH)
  firstName!: string;

  @ApiProperty({ example: 'Hassan', maxLength: CONTACT_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTACT_NAME_MAX_LENGTH)
  lastName!: string;

  @ApiPropertyOptional({
    example: 'sara@acme.com',
    description: 'Optional. Trimmed and stored lowercase. Not unique: duplicates are allowed.',
  })
  @Transform(trimLowerToNull)
  @IsEmail()
  @MaxLength(CONTACT_EMAIL_MAX_LENGTH)
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({ example: '+20 100 123 4567' })
  @Transform(trimToNull)
  @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  @MaxLength(PHONE_MAX_LENGTH)
  @IsOptional()
  phone?: string | null;

  @ApiPropertyOptional({ example: 'Head of Procurement', maxLength: CONTACT_JOB_TITLE_MAX_LENGTH })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(CONTACT_JOB_TITLE_MAX_LENGTH)
  @IsOptional()
  jobTitle?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'A company you are allowed to see. Anything else is INVALID_COMPANY.',
  })
  @IsUUID()
  @IsOptional()
  companyId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Defaults to you. A rep can only name themselves; a manager their team.',
  })
  @IsUUID()
  @IsOptional()
  ownerId?: string;
}
