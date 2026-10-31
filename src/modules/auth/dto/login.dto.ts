import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH } from '../auth.constants';

// Emails are stored lowercase and globally unique, so login normalizes the same way.
export const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class LoginDto {
  @ApiProperty({ example: 'admin@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Upper bound only: login must not reveal the policy, and it keeps argon2 input bounded.
  @ApiProperty({ example: 'a-long-password' })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
