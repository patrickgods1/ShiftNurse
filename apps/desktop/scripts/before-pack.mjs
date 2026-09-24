/**
 * electron-builder `beforePack` hook: fetch the Electron-ABI better-sqlite3 binary for the
 * *target* platform/arch, not the host building it. `npmRebuild: false` in electron-builder.yml
 * stops electron-builder recompiling the hoisted `better-sqlite3` (which would break `npm test`
 * on this machine); this hook is what puts the right binary into `better-sqlite3-electron`
 * before each target is asar'd, so a Windows installer built on macOS doesn't end up carrying a
 * darwin-arm64 `.node` file. See rebuild-sqlite-for-electron.mjs for the two-copies design.
 */
import { Arch } from 'electron-builder';
import { fetchCpsat, TARGET_DIR } from './fetch-cpsat.mjs';
import { fetchSqliteForElectron } from './rebuild-sqlite-for-electron.mjs';

const PLATFORM_MAP = {
  darwin: 'darwin',
  win32: 'win32',
  linux: 'linux',
};

export default async function beforePack(context) {
  const archName = Arch[context.arch];
  if (archName === 'universal') {
    throw new Error(
      '[before-pack] refusing to build a universal binary: mac.target builds separate ' +
        'x64 and arm64 dmgs, each with its own better-sqlite3-electron binary.',
    );
  }

  const platform = PLATFORM_MAP[context.electronPlatformName];
  if (!platform) {
    throw new Error(
      `[before-pack] unrecognised electronPlatformName: ${context.electronPlatformName}`,
    );
  }

  console.log(`[before-pack] fetching better-sqlite3-electron for ${platform}/${archName}`);
  fetchSqliteForElectron({ platform, arch: archName });

  // The CP-SAT runner for the same target, into the folder extraResources ships as
  // resources/cpsat. Fatal on failure: an installer without it silently loses two solvers.
  console.log(`[before-pack] fetching the CP-SAT runner for ${platform}/${archName}`);
  await fetchCpsat({ platform, arch: archName, dest: TARGET_DIR });
}
