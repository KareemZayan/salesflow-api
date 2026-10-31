import { ApiProperty } from '@nestjs/swagger';
import { TOKEN_TYPE } from '../auth.constants';

export class TokenResponseDto {
  @ApiProperty({ description: 'Short-lived HS256 JWT, sent as `Authorization: Bearer <token>`' })
  accessToken!: string;

  @ApiProperty({ description: 'Opaque, single-use; replaced by every refresh' })
  refreshToken!: string;

  @ApiProperty({ example: TOKEN_TYPE })
  tokenType!: typeof TOKEN_TYPE;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds' })
  expiresIn!: number;

  @ApiProperty({
    description: 'When true, only `me` and `change-password` work until the password is changed',
  })
  mustChangePassword!: boolean;
}
