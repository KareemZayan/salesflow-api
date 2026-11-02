import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../../common/policies/password-policy';
import { EMAIL_MAX_LENGTH, NAME_MAX_LENGTH } from '../users.constants';

export const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
export const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateUserDto {
  @ApiProperty({ example: 'jane.doe@acme.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({ example: 'Jane' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  firstName!: string;

  @ApiProperty({ example: 'Doe' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  lastName!: string;

  @ApiProperty({ format: 'uuid', description: 'A role of your organization' })
  @IsUUID()
  roleId!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'An active user of your organization' })
  @IsUUID()
  @IsOptional()
  managerId?: string;

  // Policy (length, blocklist) is enforced by PasswordService with a precise WEAK_PASSWORD message.
  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description: 'Temporary password; the user must change it at first sign-in',
  })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH * 2)
  temporaryPassword!: string;
}
