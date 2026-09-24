/**
 * The M15 solver benchmark: every backend, three seeds, three units, written to
 * docs/solver-bench.md. `FALLBACK_ORDER` in core cites the result.
 *
 * Units:
 * - demo — the seeded demo unit's draft period (loaded exactly as Generate loads it);
 * - synthetic-24 — 24 RNs, 4 weeks, mixed 8/12-hour shifts, night and weekend preferences;
 * - small-8 — 8 RNs, 2 weeks, tight enough that not every floor can be filled.
 *
 * Budgets are the app's own defaults: 200k annealing iterations for SA + LNS and the hybrid
 * (which also spends 8 × 2 units of deterministic time on CP-SAT windows), and 60 units of
 * deterministic time for whole-period CP-SAT.
 */

import { writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isoDate, type SolveInput, type SolveReport, solve } from '@shiftnurse/core';
import {
  coverageAllWeek,
  DAY_8,
  DAY_12,
  EVENING_8,
  makeNurse,
  NIGHT_8,
  NIGHT_12,
  resetFixtureCounters,
  solveInputFrom,
  timeOff,
} from '@shiftnurse/core/testing';
import { getPeriod, loadPeriodInput, openTestDatabase, seedDemoUnit } from '@shiftnurse/db';
import { expect, it } from 'vitest';
import { CpsatRunner, resolveRunnerPath } from './cpsat-process.js';
import { solveCpsat, solveHybrid } from './ortools-solvers.js';

const ITERATIONS = 200_000;
const SEEDS = [1, 2, 3];
const OUT = fileURLToPath(new URL('../../../../docs/solver-bench.md', import.meta.url));
const RUNNER = resolveRunnerPath({
  packaged: false,
  resourcesPath: '',
  appPath: fileURLToPath(new URL('../..', import.meta.url)),
});

function demo(): SolveInput {
  const { db } = openTestDatabase();
  const seeded = seedDemoUnit(db, { today: isoDate('2026-09-23') });
  return loadPeriodInput(db, getPeriod(db, seeded.draftPeriodId)!);
}

function synthetic24(): SolveInput {
  resetFixtureCounters();
  const nurses = Array.from({ length: 24 }, (_, i) =>
    makeNurse({ isChargeEligible: i % 3 === 0, contractedHoursPerPeriod: i % 4 === 3 ? 64 : 72 }),
  );
  const preferences = nurses.flatMap((n, i) => [
    ...(i % 3 === 0
      ? [
          {
            id: `p${i}`,
            nurseId: n.id,
            kind: 'avoid_shift_type' as const,
            shiftTypeId: NIGHT_12.id,
            weight: 4,
          },
        ]
      : []),
    ...(i % 3 === 1
      ? [
          {
            id: `p${i}`,
            nurseId: n.id,
            kind: 'prefer_shift_type' as const,
            shiftTypeId: NIGHT_12.id,
            weight: 4,
          },
        ]
      : []),
    ...(i % 5 === 0
      ? [{ id: `w${i}`, nurseId: n.id, kind: 'weekend_appetite' as const, level: -1, weight: 3 }]
      : []),
  ]);
  return solveInputFrom({
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-31'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12, DAY_8, EVENING_8, NIGHT_8],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 3, 4),
      ...coverageAllWeek(NIGHT_12, 'RN', 3, 3),
      ...coverageAllWeek(EVENING_8, 'RN', 1, 1),
    ],
    preferences,
  });
}

function small8(): SolveInput {
  resetFixtureCounters();
  const nurses = Array.from({ length: 8 }, (_, i) =>
    makeNurse({ isChargeEligible: i % 2 === 0, isNovice: i === 7 }),
  );
  return solveInputFrom({
    startDate: isoDate('2026-01-04'),
    endDate: isoDate('2026-01-17'),
    nurses,
    shiftTypes: [DAY_12, NIGHT_12, EVENING_8],
    coverageRequirements: [
      ...coverageAllWeek(DAY_12, 'RN', 2, 2),
      ...coverageAllWeek(NIGHT_12, 'RN', 1, 2),
      ...coverageAllWeek(EVENING_8, 'RN', 0, 1),
    ],
    timeOff: [timeOff(nurses[0]!.id, '2026-01-08', '2026-01-10')],
  });
}

const UNITS: [string, () => SolveInput][] = [
  ['demo', demo],
  ['synthetic-24', synthetic24],
  ['small-8', small8],
];
type Backend = 'sa-lns' | 'hybrid' | 'cp-sat';
const BACKENDS: Backend[] = ['sa-lns', 'hybrid', 'cp-sat'];

async function run(backend: Backend, input: SolveInput, seed: number): Promise<SolveReport> {
  const runnerPath = RUNNER!;
  switch (backend) {
    case 'sa-lns':
      return solve(input, { seed, maxIterations: ITERATIONS });
    case 'hybrid':
      return solveHybrid(input, { seed, maxIterations: ITERATIONS, runnerPath });
    case 'cp-sat':
      return solveCpsat(input, { seed, maxIterations: ITERATIONS, runnerPath });
  }
}

interface Row {
  unit: string;
  backend: Backend;
  seed: number;
  report: SolveReport;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const f0 = (x: number) => Math.round(x).toLocaleString('en-US');

it.skipIf(RUNNER === undefined)(
  'benchmarks every solver and writes docs/solver-bench.md',
  async () => {
    const version = await new CpsatRunner(RUNNER!).start().then(
      (v) => v,
      () => 'unknown',
    );
    const rows: Row[] = [];
    for (const [unit, make] of UNITS) {
      for (const backend of BACKENDS) {
        for (const seed of SEEDS) {
          const report = await run(backend, make(), seed);
          rows.push({ unit, backend, seed, report });
          console.log(
            unit,
            backend,
            seed,
            Math.round(report.objective.total),
            `${report.stats.elapsedMs}ms`,
          );
        }
      }
    }

    const lines: string[] = [];
    lines.push('# Solver benchmark (M15)');
    lines.push('');
    lines.push(
      `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run bench:solvers\` on ${platform()} ${release()}, ` +
        `${cpus()[0]?.model ?? 'unknown CPU'} × ${cpus().length}; OR-Tools ${version}.`,
    );
    lines.push('');
    lines.push(
      `Budgets: SA + LNS and hybrid ${ITERATIONS.toLocaleString('en-US')} annealing iterations ` +
        '(the hybrid adds 8 CP-SAT windows of 3 days × 2 units of deterministic time); CP-SAT 60 units ' +
        'of deterministic time over the whole period. Objective is in points (lower is better); a ' +
        'floor short costs 3,000.',
    );
    lines.push('');
    lines.push('## Median over seeds 1–3');
    lines.push('');
    lines.push(
      '| Unit | Solver | Objective | Coverage | Hours | Fairness | Preferences | Cost | Floors short | Time (s) |',
    );
    lines.push('|---|---|--:|--:|--:|--:|--:|--:|--:|--:|');
    const winners: Record<string, Backend> = {};
    for (const [unit] of UNITS) {
      let best: [Backend, number] | undefined;
      for (const backend of BACKENDS) {
        const rs = rows
          .filter((r) => r.unit === unit && r.backend === backend)
          .map((r) => r.report);
        const m = (pick: (r: SolveReport) => number) => median(rs.map(pick));
        const total = m((r) => r.objective.total);
        if (!best || total < best[1]) best = [backend, total];
        lines.push(
          `| ${unit} | ${backend} | ${f0(total)} | ${f0(m((r) => r.objective.coverage))} | ` +
            `${f0(m((r) => r.objective.hours))} | ${f0(m((r) => r.objective.fairness))} | ` +
            `${f0(m((r) => r.objective.preferences))} | ${f0(m((r) => r.objective.cost))} | ` +
            `${m((r) => r.unfilled.length)} | ${(m((r) => r.stats.elapsedMs) / 1000).toFixed(1)} |`,
        );
      }
      winners[unit] = best![0];
    }
    lines.push('');
    lines.push('## Every run');
    lines.push('');
    lines.push(
      '| Unit | Solver | Seed | Objective | Floors short | Gap | Windows improved | Time (s) |',
    );
    lines.push('|---|---|--:|--:|--:|--:|--:|--:|');
    for (const r of rows) {
      const s = r.report.stats;
      lines.push(
        `| ${r.unit} | ${r.backend} | ${r.seed} | ${f0(r.report.objective.total)} | ${r.report.unfilled.length} | ` +
          `${s.gap === undefined ? '—' : `${(s.gap * 100).toFixed(0)}%`} | ` +
          `${s.windows ? `${s.windows.improved}/${s.windows.tried}` : '—'} | ${(s.elapsedMs / 1000).toFixed(1)} |`,
      );
    }

    // Fallback after hybrid: whichever of SA + LNS and CP-SAT has the lower median on more units.
    const saWins = UNITS.filter(([u]) => {
      const med = (b: Backend) =>
        median(
          rows.filter((r) => r.unit === u && r.backend === b).map((r) => r.report.objective.total),
        );
      return med('sa-lns') <= med('cp-sat');
    }).length;
    const second: Backend = saWins * 2 >= UNITS.length ? 'sa-lns' : 'cp-sat';
    const third: Backend = second === 'sa-lns' ? 'cp-sat' : 'sa-lns';
    lines.push('');
    lines.push('## Result');
    lines.push('');
    lines.push(
      `Best median per unit: ${UNITS.map(([u]) => `${u} → ${winners[u]}`).join(', ')}. ` +
        `SA + LNS beats whole-period CP-SAT on ${saWins} of ${UNITS.length} units, so the fallback ` +
        `order after hybrid is **${second}, then ${third}**: \`FALLBACK_ORDER = ['hybrid', '${second}', '${third}']\`.`,
    );
    lines.push('');
    writeFileSync(OUT, `${lines.join('\n')}`);
    expect(rows.length).toBe(UNITS.length * BACKENDS.length * SEEDS.length);
  },
);
