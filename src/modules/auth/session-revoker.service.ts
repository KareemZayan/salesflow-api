import { Injectable } from '@nestjs/common';

// The slice of a (scoped or unscoped) transaction client this service needs.
export interface RefreshTokenWriter {
  refreshToken: {
    updateMany(args: {
      where: { userId: string; revokedAt: null };
      data: { revokedAt: Date };
    }): PromiseLike<unknown>;
  };
}

// The one place that signs a user out of every device. It takes the caller's transaction client so
// the revocation commits or rolls back together with whatever triggered it (password change,
// admin reset, deactivation).
@Injectable()
export class SessionRevoker {
  async revokeAllForUser(tx: RefreshTokenWriter, userId: string, at: Date): Promise<void> {
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    });
  }
}
