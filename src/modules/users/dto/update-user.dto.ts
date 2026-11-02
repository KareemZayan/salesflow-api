import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { normalizeEmail, trimString } from '../../../common/utils/string-transform.util';
import { OptionalButNotNull } from '../../../common/validators/optional-not-null.decorator';
import { EMAIL_MAX_LENGTH, NAME_MAX_LENGTH } from '../users.constants';

export class UpdateUserDto {
  @ApiPropertyOptional()
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  @OptionalButNotNull()
  email?: string;

  @ApiPropertyOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  @OptionalButNotNull()
  firstName?: string;

  @ApiPropertyOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  @OptionalButNotNull()
  lastName?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'You cannot change your own role' })
  @IsUUID()
  @OptionalButNotNull()
  roleId?: string;

  // IsOptional also lets `null` through, which is how a manager is removed.
  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String })
  @IsUUID()
  @IsOptional()
  managerId?: string | null;
}
