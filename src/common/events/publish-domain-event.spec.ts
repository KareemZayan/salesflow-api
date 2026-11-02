import { Logger } from '@nestjs/common';
import { publishDomainEvent } from './publish-domain-event';

const logger = { error: vi.fn() } as unknown as Logger;
const emitAsync = vi.fn();

beforeEach(() => vi.resetAllMocks());

describe('publishDomainEvent', () => {
  it('emits the name and payload', () => {
    emitAsync.mockResolvedValue([]);
    publishDomainEvent({ emitAsync }, logger, 'x.happened', { id: '1' }, 'x 1');
    expect(emitAsync).toHaveBeenCalledWith('x.happened', { id: '1' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs and swallows a synchronous throw', () => {
    emitAsync.mockImplementation(() => {
      throw new Error('sync');
    });
    expect(() => publishDomainEvent({ emitAsync }, logger, 'x.happened', {}, 'x 1')).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('x.happened'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('x 1'));
  });

  it('logs and swallows a rejection, without an unhandled rejection', async () => {
    emitAsync.mockRejectedValue(new Error('async'));
    publishDomainEvent({ emitAsync }, logger, 'x.happened', {}, 'x 1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('async'));
  });
});
