/**
 * The main process's log file.
 *
 * A packaged app has no console anyone reads: on Windows its stdout goes nowhere at all. So a
 * failed daily backup, a CP-SAT runner that crashed, an IPC call that threw — everything main
 * prints — also lands in `userData/logs/main.log`, which Settings › Backups can open for a
 * support request. The file rolls over at a size cap so a long-running install cannot fill a
 * disk with it. No Electron here: the folder is a parameter, so it is tested on a temp dir.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

export interface Log {
  readonly path: string;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface FileLogOptions {
  /** Roll over past this size. */
  maxBytes?: number;
  /** Old files kept: `main.1.log` (newest) to `main.<keep>.log`. */
  keep?: number;
  now?: () => number;
}

export function createFileLog(dir: string, options: FileLogOptions = {}): Log {
  const { maxBytes = 5 * 1024 * 1024, keep = 3, now = Date.now } = options;
  const path = join(dir, 'main.log');
  const rolled = (n: number) => join(dir, `main.${n}.log`);

  function rollOver(): void {
    rmSync(rolled(keep), { force: true });
    for (let n = keep - 1; n >= 1; n--) {
      if (existsSync(rolled(n))) renameSync(rolled(n), rolled(n + 1));
    }
    renameSync(path, rolled(1));
  }

  function write(level: string, args: unknown[]): void {
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(path) && statSync(path).size >= maxBytes) rollOver();
      appendFileSync(path, `${new Date(now()).toISOString()} ${level} ${format(...args)}\n`);
    } catch {
      // A log that cannot be written must not become the reason the app stops.
    }
  }

  return {
    path,
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
  };
}

/**
 * Copy everything main prints to the console into `log` as well, so modules that log with
 * `console.*` (the solver runner, the backup sweep) reach the file without knowing about it.
 */
export function teeConsole(log: Log): void {
  const pairs = [
    ['log', log.info],
    ['info', log.info],
    ['warn', log.warn],
    ['error', log.error],
  ] as const;
  for (const [method, sink] of pairs) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      sink(...args);
    };
  }
}
