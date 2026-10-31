import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokenService } from './token.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { auth } = config.getOrThrow<AppConfig>(APP_CONFIG_KEY);
        return {
          secret: auth.accessSecret,
          signOptions: {
            algorithm: JWT_ALGORITHM,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
            expiresIn: auth.accessExpiresInSeconds,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, TokenService, PasswordService, JwtStrategy],
  // PasswordService is shared with the Users module (6b) so there is one hashing policy.
  exports: [PasswordService],
})
export class AuthModule {}
