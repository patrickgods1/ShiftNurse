/**
 * Run electron-builder with `ELECTRON_RUN_AS_NODE` removed from its environment. VS Code's
 * integrated terminal exports that variable, and with it set the Electron binary electron-builder
 * launches (for the asar integrity step, among others) behaves as a bare Node runtime.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBuilderBin = require.resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [electronBuilderBin, ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
