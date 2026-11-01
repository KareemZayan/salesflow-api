import pino from 'pino';
import { LOG_REDACT_PATHS } from './logger.module';

// Runs the real redact paths through pino itself, so a typo in a path fails here.
describe('log redaction', () => {
  it('censors credentials in headers, bodies and top-level fields', () => {
    const lines: string[] = [];
    const logger = pino(
      { redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' } },
      { write: (line: string) => lines.push(line) },
    );

    logger.info({
      req: {
        headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=1' },
        body: {
          password: 'pw-1',
          temporaryPassword: 'pw-2',
          newPassword: 'pw-3',
          currentPassword: 'pw-4',
          refreshToken: 'rt-5',
        },
      },
      temporaryPassword: 'pw-6',
      dto: { newPassword: 'pw-7', passwordHash: 'hash-8' },
    });

    const output = lines.join('');
    for (const secret of [
      'abc.def.ghi',
      'sid=1',
      'pw-1',
      'pw-2',
      'pw-3',
      'pw-4',
      'rt-5',
      'pw-6',
      'pw-7',
      'hash-8',
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
