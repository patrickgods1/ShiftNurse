// Turns vitest's coverage/coverage-summary.json into a Markdown table for the CI run summary:
// one row per package (core, db, desktop main) plus the total, so a drop is visible on the
// pull request without downloading an artifact.
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

const summary = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
const METRICS = ['lines', 'statements', 'functions', 'branches'];

function areaOf(file) {
  const parts = relative(process.cwd(), file).split(sep);
  return parts[0] === 'packages' ? `packages/${parts[1]}` : parts.slice(0, 4).join('/');
}

const areas = new Map();
for (const [file, data] of Object.entries(summary)) {
  if (file === 'total') continue;
  const area = areaOf(file);
  const acc =
    areas.get(area) ?? Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]));
  for (const m of METRICS) {
    acc[m].covered += data[m].covered;
    acc[m].total += data[m].total;
  }
  areas.set(area, acc);
}

const pct = ({ covered, total }) =>
  total === 0 ? '—' : `${((100 * covered) / total).toFixed(1)}%`;
const rows = [...areas.entries()].sort(([a], [b]) => a.localeCompare(b));
console.log('### Test coverage\n');
console.log(`| Area | ${METRICS.join(' | ')} |`);
console.log(`|---|${METRICS.map(() => '---:').join('|')}|`);
for (const [area, acc] of rows)
  console.log(`| ${area} | ${METRICS.map((m) => pct(acc[m])).join(' | ')} |`);
console.log(`| **Total** | ${METRICS.map((m) => `**${pct(summary.total[m])}**`).join(' | ')} |`);
