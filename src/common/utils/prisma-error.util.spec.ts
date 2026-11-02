import { Prisma } from '../../generated/prisma/client';
import { nullIfNotFound } from './prisma-error.util';

const known = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

describe('nullIfNotFound', () => {
  it('passes the value through', async () => {
    await expect(nullIfNotFound(Promise.resolve({ id: 1 }))).resolves.toEqual({ id: 1 });
  });

  it('turns P2025 into null', async () => {
    await expect(nullIfNotFound(Promise.reject(known('P2025')))).resolves.toBeNull();
  });

  it('rethrows every other Prisma error and non-Prisma error', async () => {
    const conflict = known('P2002');
    await expect(nullIfNotFound(Promise.reject(conflict))).rejects.toBe(conflict);
    const boom = new Error('boom');
    await expect(nullIfNotFound(Promise.reject(boom))).rejects.toBe(boom);
  });
});
