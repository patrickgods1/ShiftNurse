/**
 * Boot the built app headlessly and assert the dashboard rendered. See src/main/smoke.ts.
 *
 * Exists as a script rather than an npm one-liner because `ELECTRON_RUN_AS_NODE` must be
 * absent: VS Code's terminal exports it, and with it set the Electron binary behaves as a
 * bare Node runtime and `import { app } from 'electron'` has nothing to import.
 *
 *   node scripts/smoke.mjs [--screenshot <file.png>]
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');

const env = { ...process.env, SHIFTNURSE_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const shotIndex = process.argv.indexOf('--screenshot');
if (shotIndex !== -1) env.SHIFTNURSE_SMOKE_SCREENSHOT = process.argv[shotIndex + 1];

const result = spawnSync(electron, ['.'], { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
