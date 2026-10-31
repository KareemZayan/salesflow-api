import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { APP_CONFIG_KEY, AppConfig } from '../../config/app.config';
import { REFRESH_TOKEN_BYTES } from './auth.constants';

export interface AccessTokenPayload {
  sub: string;
  org: string;
}

export interface NewRefreshToken {
  raw: string;
  hash: string;
  expiresAt: Date;
}

@Injectable()
export class TokenService {
  private readonly auth: AppConfig['auth'];

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.auth = config.getOrThrow<AppConfig>(APP_CONFIG_KEY).auth;
  }

  get accessExpiresInSeconds(): number {
    return this.auth.accessExpiresInSeconds;
  }

  get reuseGraceMs(): number {
    return this.auth.refreshReuseGraceMs;
  }

  // Only identity travels in the token. Role and permissions are loaded per request, so a change
  // takes effect immediately instead of when the token expires.
  signAccessToken(userId: string, organizationId: string): Promise<string> {
    const payload: AccessTokenPayload = { sub: userId, org: organizationId };
    return this.jwt.signAsync(payload);
  }

  // Opaque and random: nothing to decode or forge. Only its SHA-256 is stored, so a database leak
  // does not leak usable tokens (the input is high-entropy, so a plain hash is enough).
  createRefreshToken(now: Date): NewRefreshToken {
    const raw = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    return {
      raw,
      hash: this.hashRefreshToken(raw),
      expiresAt: new Date(now.getTime() + this.auth.refreshExpiresInMs),
    };
  }

  hashRefreshToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
