import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';

const AUTH_CONFIG = {
  accessSecret: 's'.repeat(32),
  accessExpiresInSeconds: 900,
  refreshExpiresInMs: 7 * 86_400_000,
  refreshReuseGraceMs: 10_000,
};

const build = (signAsync = vi.fn().mockResolvedValue('signed.jwt')) => {
  const config = { getOrThrow: () => ({ auth: AUTH_CONFIG }) } as unknown as ConfigService;
  return { tokens: new TokenService({ signAsync } as unknown as JwtService, config), signAsync };
};

describe('TokenService', () => {
  it('signs only identity into the access token', async () => {
    const { tokens, signAsync } = build();
    await expect(tokens.signAccessToken('user-1', 'org-1')).resolves.toBe('signed.jwt');
    expect(signAsync).toHaveBeenCalledWith({ sub: 'user-1', org: 'org-1' });
  });

  it('creates unique opaque refresh tokens stored only as a SHA-256 hash', () => {
    const { tokens } = build();
    const now = new Date('2026-01-01T00:00:00Z');
    const a = tokens.createRefreshToken(now);
    const b = tokens.createRefreshToken(now);

    expect(a.raw).not.toBe(b.raw);
    expect(a.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toBe(createHash('sha256').update(a.raw).digest('hex'));
    expect(a.hash).not.toContain(a.raw);
    expect(a.expiresAt.toISOString()).toBe('2026-01-08T00:00:00.000Z');
  });

  it('hashes deterministically so a presented token can be looked up', () => {
    const { tokens } = build();
    const { raw, hash } = tokens.createRefreshToken(new Date());
    expect(tokens.hashRefreshToken(raw)).toBe(hash);
  });

  it('exposes the configured lifetimes', () => {
    const { tokens } = build();
    expect(tokens.accessExpiresInSeconds).toBe(900);
    expect(tokens.reuseGraceMs).toBe(10_000);
  });
});
