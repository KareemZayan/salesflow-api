import { HttpException } from '@nestjs/common';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { assertMayGrant } from './permission-escalation.util';

const actor = (role: string, permissions: string[]): AuthenticatedUser => ({
  userId: 'u',
  organizationId: 'o',
  role,
  permissions,
  mustChangePassword: false,
});

describe('assertMayGrant', () => {
  it('lets ADMIN grant anything', () => {
    expect(() => assertMayGrant(actor('ADMIN', []), ['users:update', 'x:y'])).not.toThrow();
  });

  it('lets a user grant a subset of what they hold, duplicates included', () => {
    const a = actor('SUPPORT', ['users:read', 'users:update']);
    expect(() => assertMayGrant(a, ['users:read', 'users:read'])).not.toThrow();
    expect(() => assertMayGrant(a, [])).not.toThrow();
  });

  it('403s with the missing keys when something is not held', () => {
    try {
      assertMayGrant(actor('SUPPORT', ['users:read']), ['users:read', 'roles:manage']);
      throw new Error('expected a failure');
    } catch (error) {
      const http = error as HttpException;
      expect(http.getStatus()).toBe(403);
      expect(http.getResponse()).toMatchObject({
        code: 'CANNOT_GRANT_PERMISSION',
        details: { missing: ['roles:manage'] },
      });
    }
  });
});
