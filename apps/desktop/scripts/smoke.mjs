/**
 * Boot the built app headlessly and assert the dashboard rendered. See src/main/smoke.ts.
 *
 * Exists as a script rather than an npm one-liner because `ELECTRON_RUN_AS_NODE` must be
 * absent: VS Code's terminal exports it, and with it set the Electron binary behaves as a
 * bare Node runtime and `import { app } from 'electron'` has nothing to import.
 *
 *   node scripts/smoke.mjs [--screenshot <file.png>]
 *
 * `--packaged` boots the electron-builder output under `release/` (the real `.app`/`.exe`)
 * instead of the dev `electron` binary running `out/`. Unit tests and the plain dev-binary
 * smoke above can't see packaging mistakes — migrations missing from `resources/`, a native
 * module packed for the wrong ABI, an asar that excluded a runtime dependency — because they
 * never touch the packaged artifact. `src/main/index.ts` gates the headless self-check on
 * `SHIFTNURSE_SMOKE=1` alone (it doesn't check `app.isPackaged`), so the same env var drives
 * both. The packaged executable is auto-detected from `process.platform`/`process.arch`
 * under `release/`; `--app <path>` overrides that, e.g. to run the x64 build under Rosetta
 * on an arm64 Mac.
 *
 *   node scripts/smoke.mjs --packaged [--app <path-to-executable>] [--screenshot <file.png>]
 *
 * Two guards, both learned from v0.1.0's first draft, which launched fine here and crashed on
 * every real install (`Cannot find package 'better-sqlite3'`):
 *
 * - **A packaged app is run from a copy outside the repo.** Inside it, Node resolves a module the
 *   app forgot to ship by walking up the folders to the repo's own `node_modules`, so a missing
 *   runtime dependency passes the smoke test and fails on a user's machine. The `.app` bundle (or
 *   the unpacked Windows folder) is copied, symlinks and all, into a fresh temp directory first.
 * - **Success is a line, not an exit code.** A main process that throws on startup shows an
 *   error dialog and exits 0 once it is dismissed. The run passes only if the app printed
 *   `[smoke] PASS`, and a run that hangs (a dialog nobody will click) is killed.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const packaged = args.includes('--packaged');
const appIndex = args.indexOf('--app');
const appOverride = appIndex !== -1 ? args[appIndex + 1] : undefined;
const shotIndex = args.indexOf('--screenshot');
const screenshot = shotIndex !== -1 ? args[shotIndex + 1] : undefined;

function packagedExecutablePath() {
  const root = join(import.meta.dirname, '..');
  if (process.platform === 'darwin') {
    const dir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    return join(root, 'release', dir, 'ShiftNurse.app', 'Contents', 'MacOS', 'ShiftNurse');
  }
  if (process.platform === 'win32') {
    return join(root, 'release', 'win-unpacked', 'ShiftNurse.exe');
  }
  console.error(`[smoke] --packaged has no target for platform "${process.platform}"`);
  process.exit(1);
}

/** The folder that is the whole packaged app: the .app on macOS, the unpacked dir on Windows. */
function appRoot(execPath) {
  const marker = `.app${join('/', 'Contents', 'MacOS')}`;
  const at = execPath.indexOf(marker);
  if (at !== -1) return execPath.slice(0, at + '.app'.length);
  return dirname(execPath);
}

let command;
let commandArgs;
let scratch;
if (packaged) {
  const execPath = appOverride ?? packagedExecutablePath();
  if (!existsSync(execPath)) {
    console.error(`[smoke] packaged executable not found at ${execPath}`);
    console.error('[smoke] build it first with `npm run dist`');
    process.exit(1);
  }
  const root = appRoot(execPath);
  scratch = mkdtempSync(join(tmpdir(), 'shiftnurse-smoke-'));
  const copy = join(scratch, basename(root));
  cpSync(root, copy, { recursive: true, verbatimSymlinks: true });
  command = join(copy, relative(root, execPath));
  commandArgs = [];
  console.log(`[smoke] running a copy of the packaged app outside the repo: ${command}`);
} else {
  command = require('electron');
  commandArgs = ['.'];
}

const env = { ...process.env, SHIFTNURSE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
if (screenshot) env.SHIFTNURSE_SMOKE_SCREENSHOT = screenshot;

const PASS = '[smoke] PASS';
// The app enforces its own limit (SHIFTNURSE_SMOKE_TIMEOUT_MS, default 240 s); this one only
// catches a process that can no longer enforce anything — stuck on a crash dialog, say.
const killAfterMs = Number(env.SHIFTNURSE_SMOKE_TIMEOUT_MS ?? 240_000) + 60_000;

const outcome = await new Promise((resolve) => {
  let passed = false;
  const child = spawn(command, commandArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const watch = (stream, sink) => {
    let buffered = '';
    stream.on('data', (chunk) => {
      sink.write(chunk);
      buffered += chunk.toString();
      if (buffered.includes(PASS)) passed = true;
      buffered = buffered.slice(-PASS.length);
    });
  };
  watch(child.stdout, process.stdout);
  watch(child.stderr, process.stderr);
  const timer = setTimeout(() => {
    console.error(`[smoke] FAIL: no result after ${killAfterMs / 1000}s; killing the app`);
    child.kill('SIGKILL');
  }, killAfterMs);
  child.on('error', (err) => {
    clearTimeout(timer);
    console.error(`[smoke] FAIL: could not start ${command}: ${err.message}`);
    resolve(1);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0 && !passed) {
      console.error(
        '[smoke] FAIL: the app exited 0 without printing "[smoke] PASS" — it crashed or never ran ' +
          'the checks (a startup error dialog exits 0 when dismissed)',
      );
      resolve(1);
    } else {
      resolve(code ?? 1);
    }
  });
});

if (scratch) rmSync(scratch, { recursive: true, force: true });
process.exit(outcome);
