process.env.TZ ??= 'America/New_York';

// Times analyseConflicts on the frozen scenario period and hashes its output, so a performance
// change to the conflicts engine (or anything it simulates through) can prove the analysis is
// byte-identical. Run with `npm run bench:conflicts`; it reads the built packages, which the npm
// script rebuilds first. TZ is set in code because `TZ=x node …` does not work in Windows cmd, and
// tests run under New York, so the bench sees the same host clock they do.
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

// Seeding mints random uuids, and the analysis breaks ties and orders rows by id, so with real
// uuids the output (and its hash) differs on every run even when nothing changed. A counter in
// uuid form makes the seeded file, and therefore the hash, the same on every run (under the TZ
// above: another TZ gives another, equally stable, hash). It must be installed before
// @shiftnurse/db loads, hence the dynamic imports below.
let nextUuid = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${(nextUuid++).toString(16).padStart(12, '0')}`;
syncBuiltinESMExports();

const { analyseConflicts, isoDate } = await import('@shiftnurse/core');
const { getPeriod, loadPeriodInput, openTestDatabase, seedScenarioUnit, transact } = await import(
  '@shiftnurse/db'
);

const RUNS = 3;

const { db } = openTestDatabase();
const seeded = transact(db, (tx) => seedScenarioUnit(tx, { today: isoDate('2026-09-23') }));
const input = loadPeriodInput(db, getPeriod(db, seeded.draftPeriodId));

const times = [];
for (let i = 0; i < RUNS; i++) {
  const t = performance.now();
  const a = analyseConflicts(input);
  const ms = Math.round(performance.now() - t);
  times.push(ms);
  const h = createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0, 16);
  console.log(`run ${i} ${ms}ms conflicts=${a.conflicts.length} hash=${h}`);
}
const median = [...times].sort((x, y) => x - y)[Math.floor(RUNS / 2)];
console.log(`median ${median}ms`);
