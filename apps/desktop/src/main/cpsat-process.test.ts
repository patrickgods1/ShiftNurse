import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CpsatRunner, resolveRunnerPath, runnerFileName } from './cpsat-process.js';

const FAKE = fileURLToPath(new URL('./cpsat-fake-runner.mjs', import.meta.url));
const runners: CpsatRunner[] = [];

function fakeRunner(): CpsatRunner {
  const runner = new CpsatRunner(process.execPath, [FAKE]);
  runners.push(runner);
  return runner;
}

afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
});

describe('the CP-SAT runner client', () => {
  it('reports the solver version once the runner is up', async () => {
    expect(await fakeRunner().start()).toBe('fake-1');
  });

  it('returns the solution with its status, objective and bound, and streams progress', async () => {
    const progress: number[] = [];
    const result = await fakeRunner().solve({ fake: 'optimal' }, {}, (p) =>
      progress.push(p.objective),
    );
    expect(progress).toEqual([12]);
    expect(result).toEqual({
      status: 'OPTIMAL',
      objective: 9,
      bound: 9,
      wallMs: 10,
      values: [1, 0, 3],
    });
  });

  it('rejects a model the runner refuses, with its message', async () => {
    await expect(fakeRunner().solve({ fake: 'error' }, {})).rejects.toThrow(/model invalid/);
  });

  it('rejects a request the runner could not even parse', async () => {
    await expect(fakeRunner().solve({ fake: 'unparseable' }, {})).rejects.toThrow(/bad request/);
  });

  it('turns a runner crash into an error quoting what it printed, then recovers', async () => {
    const runner = fakeRunner();
    await expect(runner.solve({ fake: 'crash' }, {})).rejects.toThrow(/code 3.*boom: segfault/s);
    // The next solve spawns a fresh runner rather than writing into a dead pipe.
    await expect(runner.solve({ fake: 'optimal' }, {})).resolves.toMatchObject({
      status: 'OPTIMAL',
    });
  });

  it('stops a long solve and still hands back the best schedule found so far', async () => {
    const runner = fakeRunner();
    const solving = runner.solve({ fake: 'slow' }, {}, () => runner.stop());
    await expect(solving).resolves.toMatchObject({ status: 'FEASIBLE', objective: 7, values: [1] });
  });

  it('runs requests one after another rather than letting them collide', async () => {
    const runner = fakeRunner();
    const [first, second] = await Promise.all([
      runner.solve({ fake: 'optimal' }, {}),
      runner.solve({ fake: 'optimal' }, {}),
    ]);
    expect(first.status).toBe('OPTIMAL');
    expect(second.status).toBe('OPTIMAL');
  });
});

describe('finding the runner', () => {
  it('looks in resources/cpsat when packaged and .cpsat/host in development', () => {
    const root = mkdtempSync(join(tmpdir(), 'cpsat-path-'));
    const resources = join(root, 'resources');
    const app = join(root, 'app');
    mkdirSync(join(resources, 'cpsat'), { recursive: true });
    mkdirSync(join(app, '.cpsat', 'host'), { recursive: true });
    const file = runnerFileName('darwin');
    writeFileSync(join(resources, 'cpsat', file), '');

    const base = { resourcesPath: resources, appPath: app, platform: 'darwin' as const };
    expect(resolveRunnerPath({ ...base, packaged: true })).toBe(join(resources, 'cpsat', file));
    // Not fetched in development yet: CP-SAT and hybrid must report unavailable, not crash.
    expect(resolveRunnerPath({ ...base, packaged: false })).toBeUndefined();
  });

  it('names the runner with .exe on Windows only', () => {
    expect(runnerFileName('win32')).toBe('cpsat-runner.exe');
    expect(runnerFileName('darwin')).toBe('cpsat-runner');
  });
});
