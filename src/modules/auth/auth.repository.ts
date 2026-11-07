import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SessionRevoker } from './session-revoker.service';

// The unscoped client is deliberate here (see ESLint UNSCOPED_ALLOWED): login and refresh run
// before any tenant exists, so there is no organization to scope by. Every query below is keyed by
// a unique credential (email, token hash, or an id taken from a verified token).
const authContextSelect = {
  id: true,
  organizationId: true,
  email: true,
  firstName: true,
  lastName: true,
  isActive: true,
  mustChangePassword: true,
  organization: { select: { isActive: true } },
  role: {
    select: { name: true, permissions: { select: { permission: { select: { key: true } } } } },
  },
} satisfies Prisma.UserSelect;

export type AuthContextRecord = Prisma.UserGetPayload<{ select: typeof authContextSelect }>;

const loginCandidateSelect = {
  id: true,
  organizationId: true,
  passwordHash: true,
  isActive: true,
  mustChangePassword: true,
  organization: { select: { isActive: true } },
} satisfies Prisma.UserSelect;

export type LoginCandidateRecord = Prisma.UserGetPayload<{ select: typeof loginCandidateSelect }>;

const storedRefreshTokenSelect = {
  id: true,
  organizationId: true,
  userId: true,
  familyId: true,
  expiresAt: true,
  revokedAt: true,
  user: {
    select: {
      isActive: true,
      mustChangePassword: true,
      organization: { select: { isActive: true } },
    },
  },
} satisfies Prisma.RefreshTokenSelect;

export type StoredRefreshTokenRecord = Prisma.RefreshTokenGetPayload<{
  select: typeof storedRefreshTokenSelect;
}>;

export type NewRefreshTokenData = Pick<
  Prisma.RefreshTokenUncheckedCreateInput,
  'organizationId' | 'userId' | 'tokenHash' | 'familyId' | 'expiresAt'
>;

// A transaction client (or the plain client, when a single statement needs no transaction).
export type AuthDb = Prisma.TransactionClient;

@Injectable()
export class AuthRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionRevoker,
  ) {}

  // One query for everything a request needs: user, role, permissions and organization status.
  findAuthContext(userId: string): Promise<AuthContextRecord | null> {
    return this.prisma.user.findUnique({ where: { id: userId }, select: authContextSelect });
  }

  findLoginCandidate(email: string): Promise<LoginCandidateRecord | null> {
    return this.prisma.user.findUnique({ where: { email }, select: loginCandidateSelect });
  }

  async findPasswordHash(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    return user?.passwordHash ?? null;
  }

  // The transaction of every auth write that must commit together with its audit row.
  inTransaction<T>(work: (tx: AuthDb) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async markLogin(userId: string, at: Date, db: AuthDb = this.prisma): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { lastLoginAt: at } });
  }

  findRefreshToken(tokenHash: string): Promise<StoredRefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: storedRefreshTokenSelect,
    });
  }

  async createRefreshToken(data: NewRefreshTokenData, db: AuthDb = this.prisma): Promise<void> {
    await db.refreshToken.create({ data });
  }

  // Atomic rotation: the conditional updateMany is the lock. Of N concurrent requests presenting
  // the same token exactly one sees count === 1 and gets to create the successor; the others get
  // `false`. Check-then-update would let two of them both succeed.
  rotateRefreshToken(
    current: { id: string },
    successor: NewRefreshTokenData,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });
      if (count !== 1) return false;
      await tx.refreshToken.create({ data: successor });
      return true;
    });
  }

  async hasActiveToken(familyId: string, now: Date): Promise<boolean> {
    const live = await this.prisma.refreshToken.count({
      where: { familyId, revokedAt: null, expiresAt: { gt: now } },
      take: 1,
    });
    return live > 0;
  }

  // Returns how many tokens it revoked (0 = the session was already gone).
  async revokeFamily(familyId: string, at: Date, db: AuthDb = this.prisma): Promise<number> {
    const { count } = await db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: at },
    });
    return count;
  }

  // New password + every old session revoked + the caller's fresh session. The caller's
  // transaction makes it all or nothing (together with the audit row).
  async replacePassword(
    userId: string,
    passwordHash: string,
    successor: NewRefreshTokenData,
    now: Date,
    tx: AuthDb,
  ): Promise<void> {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });
    await this.sessions.revokeAllForUser(tx, userId, now);
    await tx.refreshToken.create({ data: successor });
  }
}
