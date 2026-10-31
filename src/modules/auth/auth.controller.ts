import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AllowWhenPasswordChangeRequired } from '../../common/decorators/allow-password-change.decorator';
import { AuthThrottle } from '../../common/decorators/auth-throttle.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { MeResponseDto } from './dto/me-response.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { TokenResponseDto } from './dto/token-response.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @AuthThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'INVALID_CREDENTIALS' })
  @ApiTooManyRequestsResponse({ description: 'TOO_MANY_REQUESTS (per IP + email)' })
  login(@Body() dto: LoginDto): Promise<TokenResponseDto> {
    return this.auth.login(dto);
  }

  @Public()
  @AuthThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Refresh tokens are single-use. The old token stops working immediately; if it is sent again ' +
      'within a few seconds the answer is 409 TOKEN_ROTATED_RECENTLY (keep the session, retry with ' +
      'the latest token), later than that it is treated as theft and the whole session family is revoked.',
  })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'INVALID_REFRESH_TOKEN or TOKEN_REUSED' })
  @ApiConflictResponse({ description: 'TOKEN_ROTATED_RECENTLY' })
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenResponseDto> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @AuthThrottle()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the session behind a refresh token (idempotent)' })
  @ApiNoContentResponse({ description: 'Always, even if the token is unknown or already revoked' })
  logout(@Body() dto: RefreshTokenDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  @ApiBearerAuth()
  @AllowWhenPasswordChangeRequired()
  @Get('me')
  @ApiOperation({ summary: 'The signed-in user with role and permissions' })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiUnauthorizedResponse({ description: 'UNAUTHORIZED or TOKEN_EXPIRED' })
  me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponseDto> {
    return this.auth.me(user);
  }

  @ApiBearerAuth()
  @AllowWhenPasswordChangeRequired()
  @AuthThrottle()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change the password and start a new session',
    description:
      'Revokes every refresh token of the user and returns a new token pair. Access tokens issued ' +
      'earlier remain valid until they expire.',
  })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiForbiddenResponse({ description: 'Never PASSWORD_CHANGE_REQUIRED: this route is exempt' })
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<TokenResponseDto> {
    return this.auth.changePassword(user, dto);
  }
}
