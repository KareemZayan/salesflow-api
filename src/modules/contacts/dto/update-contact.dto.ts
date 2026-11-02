import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_JOB_TITLE_MAX_LENGTH,
  CONTACT_NAME_MAX_LENGTH,
} from '../contacts.constants';

// `firstName`, `lastName` and `ownerId` are NOT NULL columns (OptionalButNotNull); the other fields
// may be cleared by sending `null` (or a blank string for the text fields). `companyId: null`
// unlinks the contact from its company.
export class UpdateContactDto {
  @ApiPropertyOptional({ maxLength: CONTACT_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTACT_NAME_MAX_LENGTH)
  @OptionalButNotNull()
  firstName?: string;

  @ApiPropertyOptional({ maxLength: CONTACT_NAME_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTACT_NAME_MAX_LENGTH)
  @OptionalButNotNull()
  lastName?: string;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'sara@acme.com' })
  @Transform(trimLowerToNull)
  @IsEmail()
  @MaxLength(CONTACT_EMAIL_MAX_LENGTH)
  @IsOptional()
  email?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @Transform(trimToNull)
  @Matches(PHONE_PATTERN, { message: 'phone must be a valid phone number' })
  @MaxLength(PHONE_MAX_LENGTH)
  @IsOptional()
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: CONTACT_JOB_TITLE_MAX_LENGTH })
  @Transform(trimToNull)
  @IsString()
  @MaxLength(CONTACT_JOB_TITLE_MAX_LENGTH)
  @IsOptional()
  jobTitle?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Link to a company you can see, or `null` to unlink.',
  })
  @IsUUID()
  @IsOptional()
  companyId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Transferring ownership needs a manager (for their team) or an admin',
  })
  @IsUUID()
  @OptionalButNotNull()
  ownerId?: string;
}
