import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/auth.constants';

export class ResetPasswordDto {
  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description: 'Temporary password; all sessions are revoked and a change is forced at sign-in',
  })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH * 2)
  temporaryPassword!: string;
}
