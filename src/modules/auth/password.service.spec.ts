import { HttpException } from '@nestjs/common';
import { PLACEHOLDER_ADMIN_PASSWORD } from '../../../prisma/seed/seed-env';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, REJECTED_PASSWORDS } from './auth.constants';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and verifies', async () => {
    const hash = await service.hash('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await service.verify(hash, 'correct horse battery')).toBe(true);
    expect(await service.verify(hash, 'wrong password!!')).toBe(false);
  });

  it('treats a malformed stored hash as a mismatch, not an error', async () => {
    expect(await service.verify('not-a-hash', 'whatever-password')).toBe(false);
  });

  it('builds the dummy hash with the same parameters as real hashes', async () => {
    const real = await service.hash('some password');
    const verifySpy = vi.spyOn(service, 'verify');
    await service.onModuleInit();
    await service.verifyDummy('guess');

    const dummyHash = verifySpy.mock.calls[0][0];
    // Everything before the salt/hash ($argon2id$v=19$m=..,t=..,p=..) must match.
    const params = (hash: string) => hash.split('$').slice(1, 4).join('$');
    expect(params(dummyHash)).toBe(params(real));
    verifySpy.mockRestore();
  });

  describe('assertAcceptable', () => {
    const code = (password: string): string | undefined => {
      try {
        service.assertAcceptable(password);
      } catch (error) {
        return ((error as HttpException).getResponse() as { code: string }).code;
      }
      return undefined;
    };

    it('accepts the boundaries', () => {
      expect(code('a'.repeat(PASSWORD_MIN_LENGTH))).toBeUndefined();
      expect(code('a'.repeat(PASSWORD_MAX_LENGTH))).toBeUndefined();
    });

    it('rejects too short and too long passwords', () => {
      expect(code('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(ERROR_CODES.WEAK_PASSWORD);
      expect(code('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe(ERROR_CODES.WEAK_PASSWORD);
    });

    it('rejects the seed placeholder (kept in sync with the seed script)', () => {
      expect(REJECTED_PASSWORDS.has(PLACEHOLDER_ADMIN_PASSWORD)).toBe(true);
      expect(code(PLACEHOLDER_ADMIN_PASSWORD)).toBe(ERROR_CODES.WEAK_PASSWORD);
    });
  });
});
