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
 *
 * Two callers, two platforms: `postinstall` runs with no args and fetches the binary for the
 * *host* (so `npm run dev` / `npm run smoke` work on the machine running this script), while
 * `before-pack.mjs` calls `fetchSqliteForElectron({ platform, arch })` once per packaging
 * target so each installer ships the binary for the machine it will run on, not the one that
 * built it. `dist.mjs` restores the host binary afterwards either way.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function parseCliArgs(argv) {
  const platformIndex = argv.indexOf('--platform');
  const archIndex = argv.indexOf('--arch');
  return {
    platform: platformIndex !== -1 ? argv[platformIndex + 1] : undefined,
    arch: archIndex !== -1 ? argv[archIndex + 1] : undefined,
  };
}

export function fetchSqliteForElectron({ platform = process.platform, arch = process.arch } = {}) {
  let electronVersion;
  try {
    electronVersion = require('electron/package.json').version;
  } catch {
    console.log('[rebuild-sqlite] electron not installed; skipping');
    return;
  }

  const pkgDir = dirname(require.resolve('better-sqlite3-electron/package.json'));
  const prebuildInstall = require.resolve('prebuild-install/bin.js', { paths: [pkgDir] });

  const result = spawnSync(
    process.execPath,
    [
      prebuildInstall,
      '--runtime',
      'electron',
      '--target',
      electronVersion,
      '--platform',
      platform,
      '--arch',
      arch,
      '--verbose',
    ],
    { cwd: pkgDir, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(
      `[rebuild-sqlite] prebuild-install failed for electron ${electronVersion} (${platform}/${arch})`,
    );
  }
  console.log(
    `[rebuild-sqlite] better-sqlite3-electron ready for electron ${electronVersion} (${platform}/${arch})`,
  );
}

// Only run as a CLI when invoked directly (postinstall, `npm run rebuild:sqlite`), not when
// imported by before-pack.mjs. Compared via pathToFileURL, not string concatenation: a bare
// `file://${process.argv[1]}` never matches on Windows (drive letters, backslashes) or any
// path with spaces/non-ASCII characters (import.meta.url is percent-encoded).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { platform, arch } = parseCliArgs(process.argv.slice(2));
  try {
    fetchSqliteForElectron({ platform, arch });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
