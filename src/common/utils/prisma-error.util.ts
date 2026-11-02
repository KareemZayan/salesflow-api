import { Prisma } from '../../generated/prisma/client';

// Lets a service turn a unique-constraint race into its own domain error without importing Prisma.
export function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

// Turns the "no row matched" error (P2025) of a guarded update/delete into `null`. Any other error
// is rethrown untouched.
export async function nullIfNotFound<T>(operation: Promise<T>): Promise<T | null> {
  try {
    return await operation;
  } catch (error) {
    if (isRecordNotFound(error)) return null;
    throw error;
  }
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
