import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The audit trigger deliberately lets TRUNCATE through (the test reset helper needs it), so the
// only protection against it is that no production code issues one (ADR 0014).
const PRODUCTION_DIRS = ['src', 'prisma/seed', 'docker'];
const SKIP = new Set(['node_modules', 'generated']);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('production code', () => {
  it('never issues a TRUNCATE', () => {
    const offenders = PRODUCTION_DIRS.flatMap(filesUnder)
      // This file mentions the word in order to look for it.
      .filter((file) => !file.endsWith('no-truncate.spec.ts'))
      .filter((file) => /\btruncate\b/i.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
