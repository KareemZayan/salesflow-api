import { isQueueBoardEnabled } from './queue-board';

describe('isQueueBoardEnabled', () => {
  it.each([
    [{}, false],
    [{ NODE_ENV: 'development' }, false],
    [{ NODE_ENV: 'development', QUEUE_BOARD_ENABLED: 'false' }, false],
    [{ NODE_ENV: 'development', QUEUE_BOARD_ENABLED: 'true' }, true],
    [{ NODE_ENV: 'test', QUEUE_BOARD_ENABLED: 'true' }, true],
    [{ QUEUE_BOARD_ENABLED: 'true' }, true],
    // Production never mounts it, whatever the flag says (the env schema also refuses to start).
    [{ NODE_ENV: 'production', QUEUE_BOARD_ENABLED: 'true' }, false],
    [{ NODE_ENV: 'production' }, false],
  ])('%j -> %s', (env, expected) => {
    expect(isQueueBoardEnabled(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});
