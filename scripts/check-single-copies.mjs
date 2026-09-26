// Fails if package-lock.json installs more than one version of a package that must be single.
// Two Reacts in one renderer break hooks at runtime ("invalid hook call") while every static check
// passes; Dependabot's React bump left React 18 hoisted beside 19 twice. A second better-sqlite3 or
// Electron would mean a native module or runtime the tests never exercised.
import { readFileSync } from 'node:fs';

const MUST_BE_SINGLE = ['react', 'react-dom', 'electron', 'better-sqlite3'];
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

const found = new Map(MUST_BE_SINGLE.map((name) => [name, new Map()]));
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  const name = path.split('node_modules/').at(-1);
  if (!found.has(name) || entry.version === undefined) continue;
  const versions = found.get(name);
  versions.set(entry.version, [...(versions.get(entry.version) ?? []), path]);
}

let failed = false;
for (const [name, versions] of found) {
  if (versions.size <= 1) continue;
  failed = true;
  console.error(`More than one ${name} in package-lock.json:`);
  for (const [version, paths] of versions) console.error(`  ${version}: ${paths.join(', ')}`);
}
if (failed) {
  console.error('Run `npm dedupe` (or align the versions) so each of these is installed once.');
  process.exit(1);
}
console.log(`single copies OK (${MUST_BE_SINGLE.join(', ')})`);
