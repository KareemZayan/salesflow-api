import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { EMAIL_MAX_LENGTH, NAME_MAX_LENGTH } from '../users.constants';
import { normalizeEmail, trimString } from './create-user.dto';

export class UpdateUserDto {
  @ApiPropertyOptional()
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  @IsOptional()
  email?: string;

  @ApiPropertyOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  @IsOptional()
  firstName?: string;

  @ApiPropertyOptional()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(NAME_MAX_LENGTH)
  @IsOptional()
  lastName?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'You cannot change your own role' })
  @IsUUID()
  @IsOptional()
  roleId?: string;

  // IsOptional also lets `null` through, which is how a manager is removed.
  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String })
  @IsUUID()
  @IsOptional()
  managerId?: string | null;
}
