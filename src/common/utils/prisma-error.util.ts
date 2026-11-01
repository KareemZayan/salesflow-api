import { Prisma } from '../../generated/prisma/client';

// Lets a service turn a unique-constraint race into its own domain error without importing Prisma.
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
