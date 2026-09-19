/**
 * Run electron-builder, then always restore the developer's own better-sqlite3-electron binary
 * to the host build — even if the build fails.
 *
 * `before-pack.mjs` swaps that binary for each packaging target in turn (mac x64, mac arm64,
 * win x64, ...), so by the time electron-builder exits the copy on disk is built for whichever
 * target packed last, not for this machine. Left alone, the next `npm run dev` or `npm run
 * smoke` would try to load a foreign-ABI `.node` file. The `finally` below is what makes `npm
 * run dist` safe to run repeatedly on a dev machine.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fetchSqliteForElectron } from './rebuild-sqlite-for-electron.mjs';

const require = createRequire(import.meta.url);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBuilderBin = require.resolve('electron-builder/cli.js');

let status = 1;
try {
  const result = spawnSync(process.execPath, [electronBuilderBin, ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
  });
  status = result.status ?? 1;
} finally {
  console.log('[dist] restoring better-sqlite3-electron for the host so dev/smoke keep working');
  try {
    fetchSqliteForElectron();
  } catch (err) {
    // A restore failure leaves the dev copy on a foreign-ABI binary — surfacing that as a plain
    // message (not an uncaught stack trace) and exiting non-zero regardless of build status is
    // what stops the next `npm run dev` from failing later with a confusing dlopen error.
    console.error(
      `[dist] build ${status === 0 ? 'succeeded' : 'failed'}; restoring the host ` +
        'better-sqlite3-electron binary failed — run `npm run rebuild:sqlite -w ' +
        `@shiftnurse/desktop\` before \`npm run dev\`: ${err.message}`,
    );
    process.exit(status === 0 ? 1 : status);
  }
}

process.exit(status);
