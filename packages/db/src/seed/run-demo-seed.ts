/**
 * CLI: build the demo database, or with `--scenarios` the test-scenario database.
 *
 *   node dist/seed/run-demo-seed.js [--demo <id> | --scenarios] [--out <path>] [--force] [--seed <n>]
 *
 * `--demo` picks one of the realistic demo units (`community-med-surg`, `va-sf-med-surg`,
 * `ca-icu`); the community med-surg unit is the default.
 * The output defaults to `demo.sqlite` (or `scenarios.sqlite`) in the working directory.
 *
 * Refuses to overwrite an existing file unless `--force` is given: a demo database that has
 * been used for evaluation may hold edits worth keeping, and "I ran the seeder again" should
 * not be how they are lost.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, transact } from '../client.js';
import { type DemoId, isDemoId, seedDemoUnit } from './demo.js';
import { seedScenarioUnit } from './scenarios.js';

interface Args {
  scenarios: boolean;
  demo: DemoId | undefined;
  out: string;
  force: boolean;
  seed: number | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const scenarios = argv.includes('--scenarios');
  const args: Args = {
    scenarios,
    demo: undefined,
    out: resolve(scenarios ? 'scenarios.sqlite' : 'demo.sqlite'),
    force: false,
    seed: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out requires a path');
      args.out = resolve(value);
    } else if (arg === '--demo') {
      const value = argv[++i] ?? '';
      if (!isDemoId(value)) throw new Error(`--demo requires a demo id, got "${value}"`);
      args.demo = value;
    } else if (arg === '--scenarios') {
      // Read above: it decides the default output path.
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--seed') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value)) throw new Error('--seed requires an integer');
      args.seed = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (existsSync(args.out)) {
    if (!args.force) {
      console.error(`Refusing to overwrite ${args.out}. Pass --force to replace it.`);
      process.exit(2);
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${args.out}${suffix}`;
      if (existsSync(file)) unlinkSync(file);
    }
  }

  const started = Date.now();
  const handle = openDatabase({ url: args.out });
  try {
    const options = args.seed === undefined ? {} : { seed: args.seed };
    const result = transact(handle.db, (tx) =>
      args.scenarios
        ? seedScenarioUnit(tx, options)
        : seedDemoUnit(tx, { ...options, demo: args.demo }),
    );
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`Seeded ${args.out} in ${elapsed}s`);
    console.log(`  unit:          ${result.unitId}`);
    console.log(
      `  draft period:  ${result.draftPeriodId} (${result.draftStart} → ${result.draftEnd})`,
    );
    console.log('  counts:');
    for (const [key, value] of Object.entries(result.counts).sort()) {
      console.log(`    ${key.padEnd(28)} ${String(value).padStart(6)}`);
    }
  } finally {
    handle.close();
  }
}

try {
  main();
} catch (error) {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
