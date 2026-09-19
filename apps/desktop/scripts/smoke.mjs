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
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

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

let command;
let commandArgs;
if (packaged) {
  const execPath = appOverride ?? packagedExecutablePath();
  if (!existsSync(execPath)) {
    console.error(`[smoke] packaged executable not found at ${execPath}`);
    console.error('[smoke] build it first with `npm run dist`');
    process.exit(1);
  }
  command = execPath;
  commandArgs = [];
} else {
  command = require('electron');
  commandArgs = ['.'];
}

const env = { ...process.env, SHIFTNURSE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
if (screenshot) env.SHIFTNURSE_SMOKE_SCREENSHOT = screenshot;

const result = spawnSync(command, commandArgs, { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
