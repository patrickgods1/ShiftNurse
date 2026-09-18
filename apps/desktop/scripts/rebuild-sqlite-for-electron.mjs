/**
 * Fetch the Electron-ABI build of better-sqlite3 into `better-sqlite3-electron`.
 *
 * Native modules are compiled against one runtime. The hoisted `better-sqlite3` is built for
 * the system Node that runs vitest and the seeder; Electron embeds a different Node with a
 * different ABI and cannot load that binary. Rebuilding the single copy for Electron would
 * break the tests, so the desktop app depends on an npm alias — a second copy of the same
 * package under a different folder name — and this script swaps *that* copy's binary for the
 * Electron prebuild. The main-process bundle aliases `better-sqlite3` → `better-sqlite3-electron`
 * (see electron.vite.config.ts), so `@shiftnurse/db` needs no knowledge of any of this.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

let electronVersion;
try {
  electronVersion = require('electron/package.json').version;
} catch {
  console.log('[rebuild-sqlite] electron not installed; skipping');
  process.exit(0);
}

const pkgDir = dirname(require.resolve('better-sqlite3-electron/package.json'));
const prebuildInstall = require.resolve('prebuild-install/bin.js', { paths: [pkgDir] });

const result = spawnSync(
  process.execPath,
  [prebuildInstall, '--runtime', 'electron', '--target', electronVersion, '--verbose'],
  { cwd: pkgDir, stdio: 'inherit' },
);
if (result.status !== 0) {
  console.error(`[rebuild-sqlite] prebuild-install failed for electron ${electronVersion}`);
  process.exit(result.status ?? 1);
}
console.log(`[rebuild-sqlite] better-sqlite3-electron ready for electron ${electronVersion}`);
