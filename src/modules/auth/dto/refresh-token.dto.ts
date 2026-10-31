import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

// Shared by refresh and logout: both are authorized by the refresh token alone.
export class RefreshTokenDto {
  @ApiProperty({ description: 'The opaque refresh token returned by login or a previous refresh' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  refreshToken!: string;
}
