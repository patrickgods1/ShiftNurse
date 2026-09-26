/**
 * electron-builder `beforePack` hook: fetch the CP-SAT runner for the *target* platform/arch, not
 * the host building it, so a Windows installer built on macOS doesn't carry a darwin binary.
 * (better-sqlite3 needs nothing here: its Node-API prebuilds for every platform ship inside the
 * package, and electron-builder.yml keeps only the target OS's.)
 */
import { Arch } from 'electron-builder';
import { fetchCpsat, TARGET_DIR } from './fetch-cpsat.mjs';

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
        'x64 and arm64 dmgs, each with its own CP-SAT runner.',
    );
  }

  const platform = PLATFORM_MAP[context.electronPlatformName];
  if (!platform) {
    throw new Error(
      `[before-pack] unrecognised electronPlatformName: ${context.electronPlatformName}`,
    );
  }

  // The CP-SAT runner for the same target, into the folder extraResources ships as
  // resources/cpsat. Fatal on failure: an installer without it silently loses two solvers.
  console.log(`[before-pack] fetching the CP-SAT runner for ${platform}/${archName}`);
  await fetchCpsat({ platform, arch: archName, dest: TARGET_DIR });
}
