import { Injectable } from '@nestjs/common';
import { runInBatches } from '../../common/utils/batch.util';
import {
  REFRESH_TOKEN_CLEANUP_BATCH_SIZE,
  REFRESH_TOKEN_CLEANUP_MAX_BATCHES,
  REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_DAYS,
} from './auth.constants';
import { RefreshTokenCleanupRepository } from './refresh-token-cleanup.repository';

@Injectable()
export class RefreshTokenCleanupService {
  constructor(private readonly repository: RefreshTokenCleanupRepository) {}

  // Removes this organization's long-expired refresh tokens (tenant from the job context) and
  // returns how many it deleted. Bounded per run; the next daily run continues.
  purgeExpired(now: Date): Promise<number> {
    const expiredBefore = new Date(
      now.getTime() - REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );
    let afterId: string | null = null;
    return runInBatches(async () => {
      const batch = await this.repository.deleteExpiredBatch({
        expiredBefore,
        now,
        afterId,
        limit: REFRESH_TOKEN_CLEANUP_BATCH_SIZE,
      });
      afterId = batch.lastId;
      return batch;
    }, REFRESH_TOKEN_CLEANUP_MAX_BATCHES);
  }
}
