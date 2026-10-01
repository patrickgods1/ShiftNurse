import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLog } from './log.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiftnurse-logs-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the main-process log file', () => {
  it('keeps a failed daily backup on disk for support to read, stamped and levelled', () => {
    const log = createFileLog(dir, { now: () => Date.UTC(2026, 9, 1, 7, 30) });
    log.error('[backup] daily backup failed: disk full');
    expect(readFileSync(log.path, 'utf8')).toBe(
      '2026-10-01T07:30:00.000Z ERROR [backup] daily backup failed: disk full\n',
    );
  });

  it('rolls the file over once it passes the size cap, keeping a few old ones', () => {
    const log = createFileLog(dir, { maxBytes: 100, keep: 2 });
    for (let i = 0; i < 20; i++) log.info(`line ${i} ${'x'.repeat(40)}`);
    expect(existsSync(join(dir, 'main.log'))).toBe(true);
    expect(existsSync(join(dir, 'main.1.log'))).toBe(true);
    expect(existsSync(join(dir, 'main.2.log'))).toBe(true);
    expect(existsSync(join(dir, 'main.3.log'))).toBe(false);
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toContain('line 19');
  });

  it('never takes the app down when the log cannot be written', () => {
    const blocked = join(dir, 'not-a-folder');
    writeFileSync(blocked, 'a file where the folder should be');
    const log = createFileLog(blocked);
    expect(() => log.error('still running')).not.toThrow();
  });
});
