import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

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

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

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

  async markLogin(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: at } });
  }

  findRefreshToken(tokenHash: string): Promise<StoredRefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: storedRefreshTokenSelect,
    });
  }

  async createRefreshToken(data: NewRefreshTokenData): Promise<void> {
    await this.prisma.refreshToken.create({ data });
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

  async revokeFamily(familyId: string, at: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  // New password + every old session revoked + the caller's fresh session, all or nothing.
  async replacePassword(
    userId: string,
    passwordHash: string,
    successor: NewRefreshTokenData,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.prisma.refreshToken.create({ data: successor }),
    ]);
  }
}
