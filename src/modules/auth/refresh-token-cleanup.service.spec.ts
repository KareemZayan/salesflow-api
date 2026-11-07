import { RefreshTokenCleanupRepository } from './refresh-token-cleanup.repository';
import { RefreshTokenCleanupService } from './refresh-token-cleanup.service';

const deleteExpiredBatch = vi.fn();
const service = new RefreshTokenCleanupService({
  deleteExpiredBatch,
} as unknown as RefreshTokenCleanupRepository);
const NOW = new Date('2026-11-07T10:00:00.000Z');

describe('RefreshTokenCleanupService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only reaches for tokens that expired more than 7 days ago', async () => {
    deleteExpiredBatch.mockResolvedValue({ removed: 0, lastId: null, exhausted: true });
    await service.purgeExpired(NOW);
    expect(deleteExpiredBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        expiredBefore: new Date('2026-10-31T10:00:00.000Z'),
        now: NOW,
        afterId: null,
      }),
    );
  });

  it('continues after the last id of the previous batch and sums what was removed', async () => {
    deleteExpiredBatch
      .mockResolvedValueOnce({ removed: 900, lastId: 'id-1000', exhausted: false })
      .mockResolvedValueOnce({ removed: 12, lastId: 'id-1500', exhausted: true });
    await expect(service.purgeExpired(NOW)).resolves.toBe(912);
    expect(deleteExpiredBatch.mock.calls[1][0]).toMatchObject({ afterId: 'id-1000' });
  });

  it('stops at the batch cap', async () => {
    deleteExpiredBatch.mockResolvedValue({ removed: 1, lastId: 'x', exhausted: false });
    await service.purgeExpired(NOW);
    expect(deleteExpiredBatch).toHaveBeenCalledTimes(50);
  });
});
