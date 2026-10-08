/**
 * Headless boot check, enabled by `SHIFTNURSE_SMOKE=1`.
 *
 * Electron apps fail in ways unit tests cannot see: a native module built for the wrong ABI,
 * a preload that never ran, a renderer that rendered nothing. This drives the real window
 * through the real IPC bridge — every route, plus one write — and exits non-zero on any
 * failure, so "the app boots and the screens render" is something a script can assert.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { addDays, SETUP_STEPS, today } from '@shiftnurse/core';
import { getPeriod, listNursesForUnit } from '@shiftnurse/db';
import type { BrowserWindow, NativeImage } from 'electron';
import { app } from 'electron';
import { nurseRecordDocument } from './api/nurse-record.js';
import { outputInput } from './api.js';
import { getDb } from './database.js';
import { htmlToPdf, renderOutput } from './output.js';

/**
 * The whole run. With the OR-Tools runner installed the solver section generates six times —
 * hybrid (the demo's default) twice, then SA + LNS and CP-SAT twice each — so it needs minutes,
 * not seconds; without the runner it finishes in well under one.
 */
/** Printed once, last, on success; `scripts/smoke.mjs` requires it. */
const SMOKE_PASS_MARKER = '[smoke] PASS: every check completed';

const TIMEOUT_MS = Number(process.env.SHIFTNURSE_SMOKE_TIMEOUT_MS ?? 240_000);

/** Each route must render an element carrying this test id. */
const ROUTES: readonly { hash: string; testId: string }[] = [
  { hash: '#/', testId: 'stat-card' },
  { hash: '#/today', testId: 'today-page' },
  { hash: '#/roster', testId: 'roster-table' },
  { hash: '#/requests', testId: 'page-header' },
  { hash: '#/schedule', testId: 'schedule-grid' },
  { hash: '#/demand', testId: 'demand-table' },
  { hash: '#/fairness', testId: 'fairness-table' },
  { hash: '#/settings', testId: 'settings-tabs' },
];

function fail(message: string): never {
  console.error(`[smoke] FAIL: ${message}`);
  app.exit(1);
  throw new Error(message);
}

/** Navigate the hash router and wait for the route's marker element. */
function visitScript(hash: string, testId: string): string {
  return `
    new Promise((resolve) => {
      location.hash = ${JSON.stringify(hash)};
      const started = Date.now();
      const tick = () => {
        const found = document.querySelectorAll('[data-testid=${JSON.stringify(testId)}]').length;
        if (found > 0 || Date.now() - started > 10000) {
          resolve({ found, text: document.body.innerText.slice(0, 300) });
        } else setTimeout(tick, 100);
      };
      tick();
    })`;
}

/** Wait for a selector, polling, for up to 10 s; resolves with how many matched. */
const WAIT_FOR = `
  const waitFor = (selector, test = () => true) => new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const found = [...document.querySelectorAll(selector)].filter(test);
      if (found.length > 0 || Date.now() - started > 10000) resolve(found);
      else setTimeout(tick, 100);
    };
    tick();
  });`;

/**
 * First run, through the real UI: the empty database must open on the welcome screen, "Explore a
 * demo unit" must list the three demos, and picking the community med-surg unit must seed it and
 * land on the dashboard without a reload — the renderer's own invalidation has to carry it there.
 * The dashboard's 10 s starts once seeding has finished, however long that took.
 * Every later check runs on that demo; `db/seed/demo/*.test.ts` covers the other two.
 */
const WELCOME_SCRIPT = `
  (async () => {
    ${WAIT_FOR}
    const api = window.shiftnurse;
    const before = await api.setup.status();
    const welcome = (await waitFor('[data-testid="setup-welcome"]')).length;
    const choices = (await waitFor('[data-testid^="setup-choose-"]')).length;
    const demo = document.querySelector('[data-testid="setup-choose-demo"]');
    if (demo) demo.click();
    const demos = (await waitFor('[data-demo-id]')).length;
    const community = document.querySelector('[data-testid="setup-demo-community-med-surg"]');
    if (community) community.click();
    // Seeding the demo takes as long as the machine needs (the emulated x64 runner once took
    // more than 10 s), so wait for it to finish before giving the dashboard its 10 s to render;
    // otherwise a slow seed reads as a dashboard that never came.
    const seeded = Date.now();
    let after = await api.setup.status();
    while (after.phase !== 'ready' && Date.now() - seeded < 180000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      after = await api.setup.status();
    }
    const dashboard = (await waitFor('[data-testid="stat-card"]')).length;
    const [unit] = await api.units.list();
    return { before: before.phase, welcome, choices, demos, dashboard, after: after.phase, mode: after.state?.mode, unit: unit?.name };
  })()`;

/**
 * The assisted guide, reopened from Settings on the demo unit: every step must render its
 * body (each embeds a real Settings editor) and Continue must reach the summary and back to
 * the dashboard. Continue applies no preset, so the demo data the later checks rely on is
 * untouched; only the setup record changes. The demo unit already has a state preset applied,
 * so even the guide's state-law step has nothing for Continue to apply.
 */
const GUIDE_SCRIPT = `
  (async () => {
    location.hash = '#/settings';
    await window.shiftnurse.setup.resume();
    return true;
  })()`;

const GUIDE_WALK_SCRIPT = `
  (async () => {
    ${WAIT_FOR}
    const api = window.shiftnurse;
    const visited = [];
    const last = ${SETUP_STEPS.length};
    for (let i = 1; i <= last; i++) {
      const current = await waitFor('[aria-current="step"]', (el) => el.textContent.startsWith(i + '.'));
      if (current.length === 0) return { visited, stuckAt: i, body: document.body.innerText.slice(0, 300) };
      visited.push(current[0].textContent);
      const button = await waitFor(i < last ? '[data-testid="setup-continue"]' : '[data-testid="setup-finish"]');
      await waitFor(i < last ? 'main > *' : '[data-testid="setup-summary"]');
      button[0]?.click();
    }
    const dashboard = (await waitFor('[data-testid="stat-card"]')).length;
    const after = await api.setup.status();
    return { visited, dashboard, after: after.phase, hash: location.hash };
  })()`;

/** Create a nurse through the bridge and read it back — proves the write path end to end. */
const WRITE_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const before = (await api.nurses.list(unit.id)).length;
    const created = await api.nurses.create({
      unitId: unit.id, employeeId: 'SMOKE-' + Date.now(), firstName: 'Smoke', lastName: 'Test',
      role: 'RN', employmentType: 'per_diem', fte: 0.2, contractedHoursPerPeriod: 0,
      seniorityDate: '2026-01-05', isChargeEligible: false, isNovice: true, isFloatEligible: true,
      active: true,
    });
    const after = (await api.nurses.list(unit.id)).length;
    const csv = await api.roster.exportCsv(unit.id);
    // Validate the seeded draft through the rule engine: proves the whole evaluation path
    // (context build, lookback, demand derivation) runs end to end over real data.
    const periods = await api.periods.list(unit.id);
    const draft = periods.find((p) => p.status === 'draft');
    const validation = draft ? await api.schedule.validate(draft.id) : undefined;
    const t0 = performance.now();
    if (draft) await api.schedule.validate(draft.id);
    const validateMs = Math.round(performance.now() - t0);
    return {
      before, after, id: created.id, csvHasNurse: csv.includes(created.employeeId),
      violations: validation?.result.violations.length ?? -1,
      rules: validation?.ruleSet.configs.length ?? -1,
      validateMs,
    };
  })()`;

/**
 * The M6 acceptance check at the data layer the grid reads from: a night shift followed by
 * the next morning's day shift breaks minimum rest, and the validator must say so for that
 * exact assignment. The grid turns a cell red from precisely this result.
 */
const REST_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const draft = (await api.periods.list(unit.id)).find((p) => p.status === 'draft');
    const types = await api.shiftTypes.list(unit.id);
    const night = types.find((t) => t.isNight && t.durationHours === 12);
    const day = types.find((t) => !t.isNight && !t.isOnCall && t.durationHours === 12);
    const nurse = (await api.nurses.list(unit.id)).find((n) => n.active && n.role === 'RN');
    const d1 = draft.startDate;
    // Calendar maths through Date.UTC, as core does: a naive day+1 breaks at month end.
    const [y, m, d] = d1.split('-').map(Number);
    const d2 = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const before = (await api.schedule.validate(draft.id)).result.violations.length;
    await api.schedule.createAssignment({ periodId: draft.id, nurseId: nurse.id, shiftTypeId: night.id, date: d1 });
    const turnaround = await api.schedule.createAssignment({ periodId: draft.id, nurseId: nurse.id, shiftTypeId: day.id, date: d2 });
    const v = (await api.schedule.validate(draft.id)).result.violations;
    const hit = v.find((x) => x.code === 'insufficient_rest' && x.assignmentIds.includes(turnaround.id));
    return { before, after: v.length, flagged: !!hit, message: hit ? hit.message : 'no insufficient_rest violation for ' + turnaround.id };
  })()`;

/**
 * The M7 acceptance check at the data layer the Fairness screen reads from: scoring runs over
 * real seeded history, and handing a nurse one more night shift on a free day never raises
 * their score. A small history import proves the CSV → ledger path without a file dialog.
 */
const FAIRNESS_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const draft = (await api.periods.list(unit.id)).find((p) => p.status === 'draft');
    const report = await api.fairness.report(draft.id);
    const badScore = report.scores.find((s) => !(s.score >= 0 && s.score <= 100) || s.components.length !== 8);
    const trend = await api.fairness.trend(unit.id);
    const types = await api.shiftTypes.list(unit.id);
    const night = types.find((t) => t.isNight && t.durationHours === 12);
    const assigned = await api.periods.assignments(draft.id);
    // A nurse for whom a weekday night honours nothing they asked for: no "prefer nights"
    // (that would legitimately raise their hit rate) and no block-length preference (a lone
    // shift on a free day is a new one-shift block). Weekend appetite is untouched by a
    // weekday night, so it is fine either way.
    let nurse;
    for (const n of await api.nurses.list(unit.id)) {
      if (!n.active || n.contractedHoursPerPeriod <= 0) continue;
      const prefs = await api.preferences.forNurse(n.id);
      const pure = prefs.every((p) =>
        (p.kind === 'avoid_shift_type' && p.shiftTypeId === night.id) ||
        p.kind === 'avoid_weekday' || p.kind === 'weekend_appetite');
      if (pure) { nurse = n; break; }
    }
    if (!nurse) throw new Error('no demo nurse without prefer/block-length preferences');
    // A date in the draft where this nurse has nothing the day before, on, or after, so the
    // extra night is a pure burden rather than a rest violation.
    const [y, m, d] = draft.startDate.split('-').map(Number);
    const day = (k) => new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
    const busy = new Set(assigned.filter((a) => a.nurseId === nurse.id).map((a) => a.date));
    let k = 3;
    while (busy.has(day(k - 1)) || busy.has(day(k)) || busy.has(day(k + 1))) k++;
    const before = report.scores.find((s) => s.nurseId === nurse.id).score;
    await api.schedule.createAssignment({ periodId: draft.id, nurseId: nurse.id, shiftTypeId: night.id, date: day(k) });
    const after = (await api.fairness.report(draft.id)).scores.find((s) => s.nurseId === nurse.id).score;
    const imported = await api.fairness.importHistory(unit.id, [
      { employeeId: nurse.employeeId, date: '2020-01-06', shiftAbbreviation: night.abbreviation },
      { employeeId: nurse.employeeId, date: '2020-01-07', shiftAbbreviation: night.abbreviation },
    ]);
    return {
      scored: report.scores.length, badScore: badScore ? badScore.nurseId : null,
      gini: report.distribution.score.gini, trendPoints: trend.length,
      before, after, nurse: nurse.firstName + ' ' + nurse.lastName, imported,
    };
  })()`;

/**
 * The M8 check: seeded history prices to real dollars with nobody unpriced, budgets sit where
 * the seeder put them, and adding a shift to the draft moves its total — the "dollar impact on
 * every decision" promise at the layer the grid and dashboard read from.
 */
const COST_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const periods = await api.periods.list(unit.id);
    const published = periods.filter((p) => p.status === 'published').sort((a, b) => a.startDate < b.startDate ? 1 : -1)[0];
    const history = await api.cost.report(published.id);
    const draft = periods.find((p) => p.status === 'draft');
    const before = await api.cost.report(draft.id);
    const types = await api.shiftTypes.list(unit.id);
    const day = types.find((t) => !t.isNight && !t.isOnCall && t.durationHours === 12);
    const nurse = (await api.nurses.list(unit.id)).find((n) => n.active && n.role === 'RN' && n.employmentType === 'full_time');
    const assigned = await api.periods.assignments(draft.id);
    const busy = new Set(assigned.filter((a) => a.nurseId === nurse.id).map((a) => a.date));
    const [y, m, d] = draft.startDate.split('-').map(Number);
    const dateAt = (k) => new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
    let k = 8;
    while (busy.has(dateAt(k))) k++;
    await api.schedule.createAssignment({ periodId: draft.id, nurseId: nurse.id, shiftTypeId: day.id, date: dateAt(k) });
    const after = await api.cost.report(draft.id);
    const budget = await api.cost.setBudget(draft.id, 123456);
    const reread = await api.cost.report(draft.id);
    return {
      historyTotal: history.cost.totals.total, historyHours: history.cost.totals.hours,
      historyUnpriced: history.cost.unpricedAssignments, historyRatio: history.variance ? history.variance.ratio : null,
      historyOvertimeNurses: history.cost.overtime.nursesWithOvertime,
      beforeTotal: before.cost.totals.total, afterTotal: after.cost.totals.total,
      budgetSet: budget.targetDollars, budgetRead: reread.variance ? reread.variance.targetDollars : null,
    };
  })()`;

/**
 * The M9 check: Generate runs a batch of variations in worker threads against the seeded draft,
 * they compare and preview, the saved one lands in the database with locked rows untouched, the
 * grid's own validator finds no nurse-level hard violation in it, and running it again on
 * unchanged inputs writes the identical schedule. A short iteration budget keeps each run to a
 * couple of seconds; the property is the same.
 */
/**
 * One variation (a batch of N gets N times this). 90 s is generous on a developer machine, where the default (hybrid) solve takes
 * ~20–35 s; CI runners are several times slower — hybrid took 79 s on windows-2022 and 87 s on
 * macos-15-intel, then 90 s+ on one Windows run — so the release workflow raises it.
 */
const SOLVE_TIMEOUT_MS = Number(process.env.SHIFTNURSE_SMOKE_SOLVE_TIMEOUT_MS ?? 90_000);

const SOLVER_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const draft = (await api.periods.list(unit.id)).find((p) => p.status === 'draft');
    const before = await api.periods.assignments(draft.id);
    const pin = before.find((a) => !a.isLocked);
    const locked = pin ? await api.schedule.setLocked(pin.id, true) : undefined;
    // One Generate: a batch of variations, then variation 1 saved to the draft (nothing reaches
    // the draft until a save). status flattens the saved run for the checks below.
    const run = async (extra = {}) => {
      const job = await api.solver.start(draft.id, { maxIterations: 20000, count: 1, ...extra });
      const started = Date.now();
      let batch = job;
      let progressSeen = 0;
      while (batch.state === 'running') {
        await new Promise((r) => setTimeout(r, 100));
        batch = await api.solver.status(job.id);
        if (batch.runs.some((r) => r.progress)) progressSeen++;
        if (Date.now() - started > ${SOLVE_TIMEOUT_MS} * job.count) throw new Error('solve did not finish in ' + ${SOLVE_TIMEOUT_MS / 1000} * job.count + 's');
      }
      const r0 = batch.runs[0];
      const applied = r0.state === 'done' ? await api.solver.save(batch.id, 0) : undefined;
      const status = {
        state: r0.state, error: r0.error, solver: r0.solver, fellBackFrom: r0.fellBackFrom,
        seed: r0.seed, summary: r0.summary, applied,
      };
      return { status, batch, progressSeen };
    };
    const key = (a) => a.nurseId + '|' + a.date + '|' + a.shiftTypeId + '|' + (a.isCharge ? 'C' : '');
    const available = await api.solver.available();
    // Every other installed backend explicitly, twice each: it must finish, keep every nurse
    // legal, and regenerate the identical schedule. A short CP-SAT budget keeps it quick. These run
    // *before* the unit's own solver (hybrid when the runner is installed), so the draft the later
    // publish and day-of checks work on is the schedule a manager would actually get.
    const others = [];
    for (const id of ['sa-lns', 'cp-sat']) {
      if (!available.some((a) => a.id === id && a.available)) continue;
      const a = await run({ solver: id, deterministicTime: 5 });
      const keysA = (await api.periods.assignments(draft.id)).map(key).sort();
      const b = await run({ solver: id, deterministicTime: 5 });
      const keysB = (await api.periods.assignments(draft.id)).map(key).sort();
      const v = await api.schedule.validate(draft.id);
      const r = a.status.summary;
      others.push({
        id, state: a.status.state, error: a.status.error, solver: r ? a.status.solver : null,
        created: a.status.applied ? a.status.applied.created : 0,
        unfilled: r ? r.unfilledSlots : -1,
        gap: r && r.gap !== undefined ? r.gap : null,
        total: r ? Math.round(r.objective) : null,
        elapsedMs: r ? r.elapsedMs : -1,
        identical: b.status.state === 'done' && JSON.stringify(keysA) === JSON.stringify(keysB),
        nurseLevel: v.result.hardViolations.filter((x) =>
          !['understaffed', 'ratio_breach', 'missing_charge_nurse', 'all_novice_shift', 'missing_credential',
            'under_contracted_hours'].includes(x.code)).map((x) => x.message).slice(0, 3),
      });
    }
    // A batch of two: both must finish, compare side by side with the draft, and preview through
    // the grid's own validation. SA + LNS, because none of that depends on the solver and a
    // hybrid batch runs one variation at a time — two more hybrid runs cost ~40 s here and
    // minutes on a CI runner. The unit's own solver runs next, and its result is the draft the
    // later checks use.
    const pair = await run({ solver: 'sa-lns', count: 2 });
    const comparison = await api.solver.compare(pair.batch.id);
    const preview = await api.solver.candidate(pair.batch.id, 1);
    const batchCheck = {
      runs: pair.batch.runs.map((r) => r.state),
      columns: comparison.candidates.length,
      previewShifts: preview.assignments.length,
      previewValidated: Array.isArray(preview.validation.result.violations),
    };
    const first = await run();
    const after = await api.periods.assignments(draft.id);
    const firstKeys = after.map(key).sort();
    const validation = await api.schedule.validate(draft.id);
    const nurseLevel = validation.result.hardViolations.filter((v) =>
      !['understaffed', 'ratio_breach', 'missing_charge_nurse', 'all_novice_shift', 'missing_credential',
        'under_contracted_hours'].includes(v.code));
    const second = await run();
    const again = (await api.periods.assignments(draft.id)).map(key).sort();
    return {
      solver: first.status.solver, fellBackFrom: first.status.fellBackFrom, batchCheck,
      orTools: available.filter((a) => a.id !== 'sa-lns').every((a) => a.available),
      others, windows: first.status.summary ? first.status.summary.windows ?? null : null,
      state: first.status.state, error: first.status.error, applied: first.status.applied,
      progressSeen: first.progressSeen, seed: first.status.seed,
      unfilled: first.status.summary ? first.status.summary.unfilledSlots : -1,
      hard: first.status.summary ? first.status.summary.hardViolations : -1,
      elapsedMs: first.status.summary ? first.status.summary.elapsedMs : -1,
      written: after.length, lockedKept: locked ? after.some((a) => a.id === locked.id && a.isLocked) : null,
      nurseLevel: nurseLevel.map((v) => v.message).slice(0, 3),
      identical: second.status.state === 'done' && JSON.stringify(firstKeys) === JSON.stringify(again),
      // How each default run was actually solved, so a mismatch says whether one of them lost
      // its CP-SAT runner part-way.
      paths: [first, second].map((r) => ({
        solver: r.status.solver, fellBackFrom: r.status.fellBackFrom ?? null,
        windows: r.status.summary ? r.status.summary.windows ?? null : null,
      })),
      secondState: second.status.state,
    };
  })()`;

/** Open Settings › Pay and wait for the seeded rates to render: a panel that throws on mount would
 * otherwise pass the route check, which only sees the tab strip. */
const PAY_TAB_SCRIPT = `
  new Promise((resolve) => {
    location.hash = '#/settings';
    const started = Date.now();
    const tick = () => {
      const tab = document.getElementById('settings-tab-pay');
      if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
      const rows = document.querySelectorAll('[data-testid="pay-rate-table"] tbody tr').length;
      const differentials = document.querySelectorAll('[data-testid="differential-table"] tbody tr').length;
      if ((rows > 1 && differentials > 1) || Date.now() - started > 10000) resolve({ rows, differentials });
      else setTimeout(tick, 100);
    };
    tick();
  })`;

/** Poll `test` (a JS expression) until truthy or `ms` pass; resolves to its last value. */
function waitScript(test: string, ms: number): string {
  return `
  new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const value = (() => { ${test} })();
      if (value || Date.now() - started > ${ms}) resolve(value || null);
      else setTimeout(tick, 100);
    };
    tick();
  })`;
}

/**
 * Generate from the Schedule page as a manager would: three SA + LNS variations through the dialog,
 * then the candidates bar, a preview with the differing shifts outlined, and the comparison table.
 * The API-level solver check above cannot see any of this render. The generate-save check then
 * saves one of these options, so the draft the later checks work on is an SA + LNS schedule.
 */
const GENERATE_UI_STEPS = {
  // A 20,000-iteration budget saved on the unit first, as the API checks pass one: this step
  // tests the screens, not schedule quality, and the default budget made it ~10 s longer.
  start: `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const settings = await api.solverSettings.get(unit.id);
    await api.solverSettings.save(unit.id, { ...settings, maxIterations: 20000 });
  })().then(() => new Promise((resolve) => {
    location.hash = '#/schedule';
    const started = Date.now();
    const set = (el, value) => {
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    let opened = false, configured = false;
    const tick = () => {
      if (Date.now() - started > 20000) return resolve({ error: 'Generate dialog never became ready' });
      if (!opened) {
        const open = document.querySelector('[data-testid="generate-open"]');
        if (open) { open.click(); opened = true; }
        return setTimeout(tick, 100);
      }
      const count = document.querySelector('[data-testid="generate-count"]');
      const solver = document.querySelector('[data-testid="generate-solver"]');
      if (!count || !solver || solver.disabled) return setTimeout(tick, 100);
      if (!configured) { set(count, '3'); set(solver, 'sa-lns'); configured = true; return setTimeout(tick, 300); }
      const estimate = document.querySelector('[data-testid="generate-estimate"]')?.textContent ?? '';
      if (!/Takes/.test(estimate)) return setTimeout(tick, 100);
      document.querySelector('[data-testid="generate-confirm"]').click();
      resolve({ estimate });
    };
    tick();
  }))`,
  summary: waitScript(
    `const done = document.querySelector('[data-testid="generate-finished"][data-state="done"]');
     return done
       ? { runs: done.querySelectorAll('[data-testid="generate-run"][data-state="done"]').length,
           names: [...done.querySelectorAll('[data-testid="generate-run"] th')].map((th) => th.textContent),
           gridBest: !!done.querySelector('[data-testid="generate-grid-best"]') }
       : null;`,
    120_000,
  ),
  // Close the summary, then come back to it from the bar: it must reopen on the summary, not on
  // a fresh setup screen (it once did, because the dialog forgot which run it had started).
  reopen: `
  (() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })(),
  ${waitScript(
    `if (document.querySelector('[data-testid="generate-dialog"]')) return null;
     const summary = [...document.querySelectorAll('[data-testid="candidates-bar"] button')]
       .find((b) => b.textContent === 'Summary');
     if (!summary) return null;
     summary.click();
     return { clicked: true };`,
    10_000,
  )}.then(() => ${waitScript(
    `const dialog = document.querySelector('[data-testid="generate-dialog"]');
     if (!dialog) return null;
     return { finished: !!dialog.querySelector('[data-testid="generate-finished"]'),
              setup: !!dialog.querySelector('[data-testid="generate-confirm"]') };`,
    10_000,
  )})`,
  // From the summary to the grid: "Preview option N" when an option wins, otherwise "Keep
  // the grid" and the bar's own preview button.
  preview: waitScript(
    `const best = document.querySelector('[data-testid="generate-preview-best"]');
     if (best) { best.click(); return null; }
     const keep = document.querySelector('[data-testid="generate-keep"]');
     if (keep) { keep.click(); return null; }
     const toggle = document.querySelector('[data-testid="candidate-preview"]');
     if (!document.querySelector('[data-testid="preview-banner"]')) {
       if (toggle && !document.querySelector('[data-testid="generate-dialog"]')) toggle.click();
       return null;
     }
     const banner = document.querySelector('[data-testid="preview-banner"]');
     if (!banner || /Loading/.test(banner.textContent)) return null;
     const outlined = document.querySelectorAll('[data-testid="assignment-chip"][aria-label*="differs from the draft"]');
     if (outlined.length === 0) return null;
     outlined[0].scrollIntoView({ block: 'center' });
     // Every readout above the grid must be the variation's: the violation count and the cost
     // strip always render, the alerts panel whenever there are alerts.
     const tagged = ['violation-summary', 'cost-summary', 'alerts-panel'].filter((id) =>
       document.querySelector('[data-testid="' + id + '"] [data-testid="preview-scope"]'));
     const alerts = !!document.querySelector('[data-testid="alerts-panel"]');
     if (tagged.length < (alerts ? 3 : 2)) return null;
     return { banner: banner.textContent, outlined: outlined.length, tagged: tagged.length };`,
    20_000,
  ),
  compare: `
  (() => { document.querySelector('[data-testid="candidate-compare"]').click(); })(),
  ${waitScript(
    `const dialog = document.querySelector('[data-testid="compare-dialog"]');
     const rows = dialog ? dialog.querySelectorAll('tbody tr').length : 0;
     const columns = dialog ? dialog.querySelectorAll('thead th').length : 0;
     return rows > 0 ? { rows, columns } : null;`,
    20_000,
  )}`,
  // Generate again from the summary: it must carry on with new seeds (options 4–6), not repeat
  // options 1–3, which on unchanged inputs would be the identical schedules.
  more: `
  (() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.__more = { stage: 'closing' };
  })(),
  ${waitScript(
    `const m = window.__more;
     const dialog = document.querySelector('[data-testid="generate-dialog"]');
     if (m.stage === 'closing') {
       if (document.querySelector('[data-testid="compare-dialog"]') || dialog) return null;
       const summary = [...document.querySelectorAll('[data-testid="candidates-bar"] button')]
         .find((b) => b.textContent === 'Summary');
       if (summary) { summary.click(); m.stage = 'summary'; }
       return null;
     }
     if (m.stage === 'summary') {
       const again = document.querySelector('[data-testid="generate-again"]');
       if (again) { again.click(); m.stage = 'setup'; }
       return null;
     }
     if (m.stage === 'setup') {
       const confirm = document.querySelector('[data-testid="generate-confirm"]');
       const box = document.querySelector('[data-testid="generate-continue"]');
       if (!confirm || !box) return null;
       m.checked = box.checked;
       m.label = confirm.textContent;
       confirm.click();
       m.stage = 'running';
       return null;
     }
     const done = document.querySelector('[data-testid="generate-finished"][data-state="done"]');
     if (!done) return null;
     const names = [...done.querySelectorAll('[data-testid="generate-run"] th')].map((th) => th.textContent);
     // The previous batch's preview must not survive into this one under the same run index.
     const carried = !!document.querySelector('[data-testid="preview-banner"]');
     return { checked: m.checked, label: m.label, names, carried };`,
    120_000,
  )}`,
  discard: `
  (() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })(),
  ${waitScript(
    `if (document.querySelector('[data-testid="compare-dialog"], [data-testid="generate-dialog"]')) return null;
     const discard = [...document.querySelectorAll('[data-testid="candidates-bar"] button')]
       .find((b) => b.textContent === 'Discard');
     if (discard) { discard.click(); return null; }
     return !document.querySelector('[data-testid="candidates-bar"]') ? { gone: true } : null;`,
    10_000,
  )}`,
};

/**
 * The schedule grid from the keyboard alone: one tab stop that arrow keys move, Enter opening the
 * shift picker on that cell, Escape closing it and handing focus back to the cell. Unit tests do
 * not render the grid; this is the only check that the roving focus and picker actually work.
 */
const GRID_KEYBOARD_SCRIPT = `
  new Promise((resolve) => {
    location.hash = '#/schedule';
    const started = Date.now();
    const key = (el, k) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const settle = (fn) => setTimeout(fn, 150);
    const tick = () => {
      const first = document.querySelector('[data-cell="0:0"]');
      if (!first) {
        if (Date.now() - started > 10000) resolve({ error: 'no grid cells rendered' });
        else setTimeout(tick, 100);
        return;
      }
      // Every tab stop in the grid, chips included: the active cell and its own shifts only.
      const grid = document.querySelector('[data-testid="schedule-grid"]');
      const tabStops = grid.querySelectorAll('[tabindex="0"]').length;
      const expectedStops = 1 + first.querySelectorAll('[data-testid="assignment-chip"]').length;
      const chips = grid.querySelectorAll('[data-testid="assignment-chip"]').length;
      first.focus();
      key(first, 'ArrowRight');
      settle(() => {
        const moved = document.activeElement?.dataset?.cell;
        key(document.activeElement, 'Enter');
        settle(() => {
          const picker = document.querySelector('[data-testid="shift-picker"]');
          const focusInPicker = !!picker && picker.contains(document.activeElement);
          const options = picker ? picker.querySelectorAll('button').length : 0;
          key(document.activeElement, 'Escape');
          settle(() => {
            resolve({
              tabStops,
              expectedStops,
              chips,
              moved,
              pickerOpened: !!picker,
              focusInPicker,
              options,
              pickerClosed: !document.querySelector('[data-testid="shift-picker"]'),
              focusBack: document.activeElement?.dataset?.cell,
            });
          });
        });
      });
    };
    tick();
  })`;

/** M15: Settings › Solver lists every backend, with the saved choice checked and the ones this
 * install cannot run marked with the reason. */
const SOLVER_TAB_SCRIPT = `
  new Promise((resolve) => {
    location.hash = '#/settings';
    const started = Date.now();
    const tick = () => {
      const tab = document.getElementById('settings-tab-solver');
      if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
      const options = [...document.querySelectorAll('[data-testid^="solver-option-"]')];
      const checked = options.find((o) => o.checked);
      const panel = document.querySelector('[data-testid="solver-settings"]');
      const unavailable = panel ? (panel.textContent.match(/Not available here/g) || []).length : 0;
      if (options.length === 3 || Date.now() - started > 10000) {
        resolve({ options: options.length, checked: checked ? checked.value : null, unavailable });
      } else setTimeout(tick, 100);
    };
    tick();
  })`;

/**
 * M10: file a pending request through the bridge, simulate approving it against the demo
 * draft, analyse the draft's conflicts, and confirm auto-resolve applies nothing while the
 * policy is off — the one guarantee the policy's default exists to give.
 */
const REQUESTS_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const periods = await api.periods.list(unit.id);
    const draft = periods.find((p) => p.status === 'draft');
    if (!draft) return { error: 'no draft period' };
    const nurses = await api.nurses.list(unit.id);
    const nurse = nurses.find((n) => n.active);
    const request = await api.timeOff.create({
      nurseId: nurse.id,
      startDate: draft.startDate,
      endDate: draft.startDate,
      type: 'pto',
      reason: 'smoke',
    });
    const impact = await api.timeOff.impact(draft.id, request.id, 'approved');
    const report = await api.conflicts.analyse(draft.id);
    const policy = await api.conflicts.policy(unit.id);
    const auto = await api.conflicts.autoResolve(draft.id);
    let denyWithoutReason = false;
    try {
      await api.timeOff.deny(request.id, '   ');
    } catch {
      denyWithoutReason = true;
    }
    return {
      status: request.status,
      impactDecision: impact.decision,
      competing: impact.competing.length,
      hasSummary: typeof report.summary === 'object' && report.summary !== null,
      conflicts: report.conflicts.length,
      resolutions: report.resolutions.length,
      policyEnabled: policy.enabled,
      autoApplied: auto.applied.length,
      denyWithoutReason,
    };
  })()`;

/**
 * M11: propose a trade between two nurses who each hold a shift on a different day in the
 * demo draft, evaluate it live, decide it (approve if the verdict allows, deny with a reason
 * otherwise), and confirm a denial with a blank reason is refused on a second, freshly
 * proposed swap — the same guarantee `timeOff.deny` gives, now for exchanges.
 */
const EXCHANGE_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const periods = await api.periods.list(unit.id);
    const draft = periods.find((p) => p.status === 'draft');
    if (!draft) return { error: 'no draft period' };
    const assignments = await api.periods.assignments(draft.id);
    const byNurse = new Map();
    // The solver smoke pinned one row earlier; a lock refuses to move, by design.
    for (const a of assignments) {
      if (a.isLocked) continue;
      if (!byNurse.has(a.nurseId)) byNurse.set(a.nurseId, []);
      byNurse.get(a.nurseId).push(a);
    }
    const candidates = [...byNurse.entries()].filter(([, list]) => list.length > 0);
    if (candidates.length < 2) return { error: 'fewer than two nurses hold a shift in the draft' };
    // Try a handful of pairs so the approval path runs when any legal trade exists; the
    // first pair is often a same-day double-booking, which is a correct block, not a bug.
    let proposal;
    let evaluation;
    outer: for (let i = 0; i < Math.min(candidates.length, 6); i++) {
      for (let j = i + 1; j < Math.min(candidates.length, 8); j++) {
        const [nurseAId, aAssignments] = candidates[i];
        const [nurseBId, bAssignments] = candidates[j];
        const worksOn = (list, date) => list.some((x) => x.date === date);
        let offered;
        let requested;
        for (const a of aAssignments) {
          const r = bAssignments.find(
            (b) =>
              b.date !== a.date &&
              b.shiftTypeId === a.shiftTypeId &&
              !worksOn(bAssignments, a.date) &&
              !worksOn(aAssignments, b.date),
          );
          if (r) { offered = a; requested = r; break; }
        }
        if (!offered || !requested) continue;
        const candidate = {
          kind: 'trade',
          requestingNurseId: nurseAId,
          counterpartyNurseId: nurseBId,
          offeredAssignmentId: offered.id,
          requestedAssignmentId: requested.id,
        };
        const verdict = await api.exchange.evaluate(draft.id, candidate);
        if (!proposal) { proposal = candidate; evaluation = verdict; }
        if (verdict.verdict !== 'blocked') { proposal = candidate; evaluation = verdict; break outer; }
      }
    }
    if (!proposal) return { error: 'no trade candidate found' };
    const swap = await api.exchange.propose(draft.id, proposal, 'smoke trade');
    let decided;
    let decideError;
    try {
      decided =
        evaluation.verdict === 'blocked'
          ? await api.exchange.deny(swap.id, 'blocked by hard rule breach')
          : await api.exchange.approve(swap.id, 'smoke approval');
    } catch (e) {
      decideError = String(e);
    }

    const secondSwap = await api.exchange.propose(draft.id, proposal, 'smoke trade 2');
    let blankDenyRefused = false;
    try {
      await api.exchange.deny(secondSwap.id, '   ');
    } catch {
      blankDenyRefused = true;
    }
    await api.exchange.cancel(secondSwap.id, 'smoke cleanup');

    return {
      verdict: evaluation.verdict,
      blockers: evaluation.blockers,
      proposedStatus: swap.status,
      decidedStatus: decided ? decided.status : undefined,
      decideError,
      blankDenyRefused,
    };
  })()`;

/**
 * The M12 acceptance check: publish, edit with a reason, and confirm the change log and the
 * versions tell the full story. Runs last because it turns the demo draft into a published
 * period, and everything before it needs a draft.
 */
const PUBLISH_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const draft = (await api.periods.list(unit.id)).find((p) => p.status === 'draft');
    if (!draft) return { error: 'no draft to publish' };
    const preview = await api.publish.preview(draft.id);
    const first = await api.publish.publish(draft.id);
    const types = await api.shiftTypes.list(unit.id);
    const day = types.find((t) => !t.isNight && !t.isOnCall && t.durationHours === 12);
    const nurse = (await api.nurses.list(unit.id)).find((n) => n.active && n.employmentType === 'per_diem');
    const taken = new Set((await api.periods.assignments(draft.id)).filter((a) => a.nurseId === nurse.id).map((a) => a.date));
    const [y, m, d] = draft.endDate.split('-').map(Number);
    let date = draft.endDate;
    for (let back = 0; back < 14 && taken.has(date); back++) {
      date = new Date(Date.UTC(y, m - 1, d - back - 1)).toISOString().slice(0, 10);
    }
    let refused = false;
    try {
      await api.schedule.createAssignment({ periodId: draft.id, nurseId: nurse.id, shiftTypeId: day.id, date });
    } catch (e) { refused = /requires a reason/.test(String(e)); }
    const added = await api.schedule.createAssignment(
      { periodId: draft.id, nurseId: nurse.id, shiftTypeId: day.id, date },
      'Smoke: cover a call-off',
    );
    const changes = await api.publish.changes(draft.id);
    const second = await api.publish.preview(draft.id);
    const republished = await api.publish.publish(draft.id, 'Smoke: republish after cover');
    const versions = await api.publish.versions(draft.id);
    const csv = await api.output.renderCsv(draft.id, 'csv-long');
    const backups = await api.backups.list();
    const period = (await api.periods.list(unit.id)).find((p) => p.id === draft.id);
    return {
      periodId: draft.id,
      previewHard: preview.hardViolations,
      alertKinds: preview.alerts.reduce((acc, a) => ({ ...acc, [a.kind]: (acc[a.kind] ?? 0) + 1 }), {}),
      previewAdded: preview.diff.added,
      firstVersion: first.version.version,
      ledgerEntries: first.ledgerEntries,
      firstBackup: first.backup ? first.backup.fileName : null,
      refused,
      changeReasons: changes.map((c) => c.kind + ':' + c.reason),
      changeAssignment: changes[0] ? changes[0].assignmentId === added.id : false,
      pendingChanges: second.pendingChanges.length,
      diffAdded: second.diff.added,
      diffRemoved: second.diff.removed,
      secondVersion: republished.version.version,
      versions: versions.map((v) => v.version + ':' + v.added + '/' + v.removed + '/' + v.changed),
      csvHasNurse: csv.includes(nurse.employeeId + ',' + date + ',' + day.abbreviation),
      publishBackups: backups.filter((b) => b.kind === 'publish').length,
      status: period.status,
    };
  })()`;

/**
 * The M13 check: the day-of console reads the published period, a call-off tags the roster row
 * without removing it, the replacement finder ranks only eligible nurses straight-time before
 * overtime before agency, a backfill writes the callout row and closes the call-off, and — since
 * the period is published by this point — the swap lands in the change log as a removed/added
 * pair with a `Call-off:` reason. Runs after `PUBLISH_SCRIPT` on purpose: only then is there a
 * published period whose backfill must go through the change log rather than a bare edit.
 */
function dayOfScript(periodId: string): string {
  return `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const period = (await api.periods.list(unit.id)).find((p) => p.id === ${JSON.stringify(periodId)});
    if (!period) return { error: 'published period not found' };
    // The demo draft starts next Sunday, so today() is never inside it — always pass a date,
    // computed the same way the other scripts do: Date.UTC on the split parts.
    const [y, m, d] = period.startDate.split('-').map(Number);
    const dayAt = (k) => new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);

    // A call-off whose replacement list is empty is a legitimate outcome — on a tightly packed
    // schedule every other RN can be resting, capped or already on — so take the first 12h day
    // RN, over the period's first few days, whose call-off does have a candidate. Each call-off
    // without one is cancelled, with a reason, before trying the next. Only if none of them has
    // a replacement is that a failure.
    let date, summary, absent, callOff, report;
    let tried = 0;
    search: for (const k of [3, 4, 5, 6]) {
      const day = dayAt(k);
      const view = await api.dayOf.today(unit.id, day);
      for (const s of view.shifts) {
        // The Today view also carries the current and next shift, which after 19:00 is
        // tomorrow's day shift: only this date's shifts are the ones being called off.
        if (s.date !== day) continue;
        if (!(s.shiftType.durationHours === 12 && !s.shiftType.isNight && !s.shiftType.isOnCall)) continue;
        for (const entry of s.roster.filter((r) => r.nurse.role === 'RN')) {
          tried++;
          const c = await api.dayOf.reportCallOff(entry.assignment.id, 'Smoke: sick');
          const r = await api.dayOf.replacements(c.id);
          if (r.candidates.length > 0) {
            date = day; summary = view; absent = entry; callOff = c; report = r;
            break search;
          }
          await api.dayOf.cancelCallOff(c.id, 'Smoke: no eligible replacement, trying another shift');
        }
      }
    }
    if (!absent) return { error: 'no 12h day RN call-off with any eligible replacement (' + tried + ' tried)' };
    const shiftsCount = summary.shifts.length;
    const hasStaffing = summary.shifts.every((s) => s.staffing && s.staffing.byRole.RN);
    const periodMatches = !!summary.period && summary.period.id === period.id;
    const rosterCount = summary.shifts.reduce((n, s) => n + s.roster.length, 0);

    let duplicateRefused = false;
    try {
      await api.dayOf.reportCallOff(absent.assignment.id, 'Smoke: sick again');
    } catch (e) {
      duplicateRefused = /already open/i.test(String(e));
    }

    const after = await api.dayOf.today(unit.id, date);
    let taggedCallOff = false;
    for (const s of after.shifts) {
      const row = s.roster.find((r) => r.assignment.id === absent.assignment.id);
      if (row && row.callOff && row.callOff.id === callOff.id) taggedCallOff = true;
    }
    const openCount = after.openCallOffs.length;
    const openView = after.openCallOffs.find((v) => v.callOff.id === callOff.id);
    const openViewOk =
      !!openView && openView.attempts.length === 0 && !!openView.assignment &&
      openView.nurse.id === absent.nurse.id;


    const candidateCount = report.candidates.length;
    const excludedCount = report.excluded.length;
    const tiers = report.candidates.map((c) => c.payTier);
    const ranks = report.candidates.map((c) => c.rank);
    const nurses = await api.nurses.list(unit.id);
    const nurseById = new Map(nurses.map((n) => [n.id, n]));
    const sameRole =
      report.absent.role === 'RN' &&
      report.candidates.every((c) => nurseById.get(c.nurseId)?.role === 'RN');
    const candidateIds = new Set(report.candidates.map((c) => c.nurseId));
    const excludedIds = new Set(report.excluded.map((e) => e.nurseId));
    const disjoint = [...candidateIds].every((id) => !excludedIds.has(id));
    const absentNotListed = !candidateIds.has(absent.nurse.id) && !excludedIds.has(absent.nurse.id);
    const excludedReasons = [...new Set(report.excluded.map((e) => e.reason.slice(0, 40)))];
    const notCallout = report.candidates.filter(
      (c) => c.assignment.source !== 'callout' || c.assignment.date !== date,
    );
    const allCallout = notCallout.length === 0;
    const notCalloutDetail = JSON.stringify({ date, rows: notCallout.map((c) => c.assignment) });

    const attempt = await api.dayOf.logCall(callOff.id, report.candidates[0].nurseId, 'no_answer', 'smoke');
    let acceptedRefused = false;
    try {
      await api.dayOf.logCall(callOff.id, report.candidates[0].nurseId, 'accepted');
    } catch (e) {
      acceptedRefused = true;
    }

    const result = await api.dayOf.backfill(callOff.id, report.candidates[0].nurseId, 'smoke pickup');
    const covered =
      result.callOff.status === 'covered' && result.callOff.replacementAssignmentId === result.assignment.id;
    const calloutSource = result.assignment.source === 'callout';
    const acceptedLogged = result.attempt.outcome === 'accepted';

    const changes = await api.publish.changes(period.id);
    const backfillEntries = changes.filter((c) => c.source === 'backfill');
    const backfillChanges = backfillEntries.map((c) => c.kind);
    const backfillReasonOk = backfillEntries.every(
      (c) => !!c.reason && c.reason.startsWith('Call-off:'),
    );

    const log = await api.dayOf.callLog(callOff.id);
    const logOutcomes = log.map((a) => a.outcome);

    const assignmentsAfter = await api.periods.assignments(period.id);
    const absentGone = !assignmentsAfter.some((a) => a.id === absent.assignment.id);
    const replacementPresent = assignmentsAfter.some((a) => a.id === result.assignment.id);

    const stillOpen = (await api.dayOf.today(unit.id, date)).openCallOffs.some(
      (v) => v.callOff.id === callOff.id,
    );
    const viewAfter = (await api.dayOf.callOffs(unit.id, date, date)).find(
      (v) => v.callOff.id === callOff.id,
    );
    const viewHasReplacement =
      !!viewAfter && !!viewAfter.replacement && viewAfter.replacement.nurse.id === report.candidates[0].nurseId;
    const viewAssignmentGone = !!viewAfter && viewAfter.assignment === undefined;

    // Cancelling a second, unrelated call-off proves the blank-reason guard the same way
    // timeOff.deny and exchange.deny do, without disturbing the covered one above.
    let secondAbsent;
    outer: for (const s of after.shifts) {
      for (const r of s.roster) {
        if (r.assignment.id !== absent.assignment.id && !r.callOff) { secondAbsent = r; break outer; }
      }
    }
    if (!secondAbsent) return { error: 'no second roster entry to cancel a call-off against' };
    const callOff2 = await api.dayOf.reportCallOff(secondAbsent.assignment.id, 'Smoke: cleanup target');
    let cancelBlankRefused = false;
    try {
      await api.dayOf.cancelCallOff(callOff2.id, '   ');
    } catch (e) {
      cancelBlankRefused = true;
    }
    const cancelled = (await api.dayOf.cancelCallOff(callOff2.id, 'smoke cleanup')).status === 'cancelled';

    return {
      shiftsCount, hasStaffing, periodMatches, rosterCount,
      duplicateRefused, taggedCallOff, openCount, openViewOk,
      candidateCount, excludedCount, tiers, ranks, sameRole, disjoint, absentNotListed,
      excludedReasons, allCallout, notCalloutDetail,
      acceptedRefused, covered, calloutSource, acceptedLogged,
      backfillChanges, backfillReasonOk, logOutcomes,
      absentGone, replacementPresent, stillOpen, viewHasReplacement, viewAssignmentGone,
      cancelBlankRefused, cancelled, date,
    };
  })()`;
}

/**
 * Saving an option from the candidates bar: the bar's own Save button, not `solver.save` through
 * the bridge, must write the option to the draft. The bar then says so, and the draft's rows
 * (read back through the bridge) are no longer the schedule they were.
 */
const SAVE_CANDIDATE_SCRIPT = `
  (async () => {
    ${WAIT_FOR}
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const draft = (await api.periods.list(unit.id)).find((p) => p.status === 'draft');
    const key = (a) => a.nurseId + '|' + a.date + '|' + a.shiftTypeId;
    const before = (await api.periods.assignments(draft.id)).map(key).sort();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const save = await waitFor('[data-testid="candidate-save"]',
      () => !document.querySelector('[data-testid="generate-dialog"], [data-testid="compare-dialog"]'));
    if (save.length === 0) return { error: 'the candidates bar has no Save button' };
    save[0].click();
    // Saving replaces the grid's unlocked shifts, so the page asks first.
    const accept = await waitFor('[data-testid="confirm-accept"]');
    if (accept.length === 0) return { error: 'Save did not ask for confirmation' };
    accept[0].click();
    const saved = await waitFor('[data-testid="candidate-saved"]');
    const after = (await api.periods.assignments(draft.id)).map(key).sort();
    const current = await api.solver.current(draft.id);
    return {
      saved: saved.length, text: saved[0]?.textContent ?? '',
      changed: JSON.stringify(before) !== JSON.stringify(after),
      savedIndex: current ? current.saved ?? null : null, before: before.length, after: after.length,
    };
  })()`;

/**
 * One drag of a chip to an empty day in the same row, then the toast's Undo: the shift must be
 * back on its nurse, day and shift type. Keyed on nurse|date|shift because a move re-creates the
 * row (new id), so ids cannot tell "back where it was" from "somewhere else".
 */
const UNDO_MOVE_SCRIPT = `
  (async () => {
    ${WAIT_FOR}
    location.hash = '#/schedule';
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const draft = (await api.periods.list(unit.id)).find((p) => p.status === 'draft');
    const key = (a) => a.nurseId + '|' + a.date + '|' + a.shiftTypeId;
    const keys = async () => (await api.periods.assignments(draft.id)).map(key).sort();
    const until = async (fn, ms = 10000) => {
      const started = Date.now();
      while (Date.now() - started < ms) {
        const value = await fn();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    };
    const chips = await waitFor('[data-testid="assignment-chip"][draggable="true"]');
    let chip, target;
    for (const c of chips) {
      const cell = c.closest('[data-cell]');
      if (!cell) continue;
      const [row, col] = cell.dataset.cell.split(':');
      target = [...document.querySelectorAll('[data-cell^="' + row + ':"]')].find(
        (el) => el.dataset.cell !== cell.dataset.cell && !el.querySelector('[data-testid="assignment-chip"]'));
      if (target) { chip = c; break; }
    }
    if (!chip) return { error: 'no unlocked chip with an empty day beside it' };
    const before = await keys();
    const dt = new DataTransfer();
    const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(chip, 'dragstart'); fire(target, 'dragenter'); fire(target, 'dragover'); fire(target, 'drop'); fire(chip, 'dragend');
    const moved = await until(async () => { const k = await keys(); return JSON.stringify(k) !== JSON.stringify(before) ? k : null; });
    if (!moved) return { error: 'dropping the chip on an empty day moved nothing' };
    const added = moved.filter((k) => !before.includes(k)).length;
    const removed = before.filter((k) => !moved.includes(k)).length;
    const undo = await until(() => [...document.querySelectorAll('[role="status"] button')].find((b) => b.textContent === 'Undo'));
    if (!undo) return { error: 'the move offered no Undo toast', added, removed };
    undo.click();
    const restored = await until(async () => JSON.stringify(await keys()) === JSON.stringify(before));
    return { added, removed, restored: !!restored, total: before.length };
  })()`;

/**
 * Time off with cover, as a manager does it: a pending request on a day the nurse works, the
 * Requests page's Review dialog, a cover picked from its list, "Approve and cover". The request
 * and the cover are then read back through the bridge. A request is made per candidate shift
 * until one has legal cover; the others are cancelled with a reason.
 */
const LEAVE_PREPARE_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const draft = (await api.periods.list(unit.id)).find((p) => p.status === 'draft');
    const rows = (await api.periods.assignments(draft.id)).filter((a) => !a.isLocked && !a.isCharge);
    let tried = 0;
    for (const a of rows.slice(20, 80)) {
      tried++;
      const request = await api.timeOff.create({
        nurseId: a.nurseId, startDate: a.date, endDate: a.date, type: 'pto', reason: 'smoke cover',
      });
      const options = await api.timeOff.coverOptions(draft.id, request.id);
      const option = options.find((o) => o.candidates.length > 0);
      if (option) {
        return { periodId: draft.id, requestId: request.id, nurseId: a.nurseId, freed: options.map((o) => ({ id: o.assignment.id, date: o.assignment.date, shiftTypeId: o.assignment.shiftTypeId })) };
      }
      await api.timeOff.cancel(request.id, 'Smoke: nobody can cover this one, trying another');
    }
    return { error: 'no shift in the draft has legal cover (' + tried + ' tried)' };
  })()`;

const LEAVE_UI_SCRIPT = `
  (async () => {
    ${WAIT_FOR}
    const until = async (fn, ms = 10000) => {
      const started = Date.now();
      while (Date.now() - started < ms) {
        const value = await fn();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    };
    location.hash = '#/requests';
    const review = await until(() => [...document.querySelectorAll('[data-testid="review-request"]')]
      .find((b) => b.closest('tr')?.textContent.includes('smoke cover')));
    if (!review) return { error: 'the pending request is not on the Requests page' };
    review.click();
    const picks = await waitFor('[data-testid="decide-dialog"] [data-testid="cover-pick"]');
    if (picks.length === 0) return { error: 'the decide dialog offered no cover for the freed shift' };
    // The dialog preselects the best candidate; take another when there is one, so the choice
    // made in the list, not the default, is what must reach the schedule.
    const chosen = [];
    for (const pick of picks) {
      const nurses = [...pick.options].map((o) => o.value).filter((v) => v !== '');
      const value = nurses[Math.min(1, nurses.length - 1)];
      if (value === undefined) continue;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(pick, value);
      pick.dispatchEvent(new Event('change', { bubbles: true }));
      chosen.push(value);
    }
    await new Promise((r) => setTimeout(r, 200));
    const approve = document.querySelector('[data-testid="approve-request"]');
    if (!approve || approve.textContent !== 'Approve and cover') {
      return { error: 'the approve button reads "' + (approve ? approve.textContent : 'missing') + '"' };
    }
    approve.click();
    const closed = await until(() => !document.querySelector('[data-testid="decide-dialog"]'), 15000);
    return { chosen, closed: !!closed, picks: picks.length };
  })()`;

function leaveCheckScript(requestId: string, periodId: string, freedIds: string[]): string {
  return `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const request = (await api.timeOff.list(unit.id)).find((r) => r.id === ${JSON.stringify(requestId)});
    const after = await api.periods.assignments(${JSON.stringify(periodId)});
    const freedIds = ${JSON.stringify(freedIds)};
    return {
      status: request ? request.status : 'missing',
      freedGone: freedIds.every((id) => !after.some((a) => a.id === id)),
      assignments: after.map((a) => ({ id: a.id, nurseId: a.nurseId, date: a.date, shiftTypeId: a.shiftTypeId })),
    };
  })()`;
}

/**
 * "Someone called off" on Today, through the button: pick a nurse from the roster, confirm the
 * report, and the card must appear and the bridge must list the call-off. Today is the host's
 * date; the demo's published history covers it.
 */
const CALL_OFF_BUTTON_SCRIPT = `
  (async () => {
    ${WAIT_FOR}
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const until = async (fn, ms = 10000) => {
      const started = Date.now();
      while (Date.now() - started < ms) {
        const value = await fn();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    };
    location.hash = '#/today';
    const button = (await waitFor('[data-testid="someone-called-off"]'))[0];
    if (!button) return { error: 'Today has no "Someone called off" button' };
    const cardsBefore = document.querySelectorAll('[data-testid="call-off-card"]').length;
    const openBefore = (await api.dayOf.today(unit.id)).openCallOffs.map((v) => v.callOff.id);
    button.click();
    const options = await waitFor('[data-testid="call-off-picker"] li button:not([disabled])');
    if (options.length === 0) return { error: 'the picker offered nobody on today’s roster' };
    const picked = options[0].textContent;
    options[0].click();
    const confirm = await until(() => [...document.querySelectorAll('[data-testid="reason-dialog"] button[type="submit"]')]
      .find((b) => b.textContent === 'Report call-off'));
    if (!confirm) return { error: 'picking a nurse did not open the report dialog' };
    confirm.click();
    const card = await until(() => document.querySelectorAll('[data-testid="call-off-card"]').length === cardsBefore + 1);
    const open = (await api.dayOf.today(unit.id)).openCallOffs;
    const added = open.filter((v) => !openBefore.includes(v.callOff.id));
    return {
      picked, cardShown: !!card, cardsBefore, added: added.map((v) => v.nurse.lastName + ', ' + v.nurse.firstName),
    };
  })()`;

/**
 * Settings is grouped tabs: one tab clicked in each group must select and show a panel with
 * content, and the deep links the grid uses (`?tab=rules&rule=<id>`) must open Rules with that
 * rule's card on screen. Opened cold, from another route, as a link does.
 */
const SETTINGS_GROUPS_SCRIPT = `
  (async () => {
    ${WAIT_FOR}
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const until = async (fn, ms = 10000) => {
      const started = Date.now();
      while (Date.now() - started < ms) {
        const value = await fn();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 150));
      }
      return null;
    };
    await until(() => { location.hash = '#/settings'; return document.getElementById('settings-tab-unit'); });
    const visited = [];
    for (const [group, tab] of [['unit', 'unit'], ['contract', 'pay'], ['scheduling', 'solver'], ['data', 'about']]) {
      const el = document.getElementById('settings-tab-' + tab);
      const heading = document.getElementById('settings-group-' + group);
      const inGroup = !!el && !!heading && el.closest('[role="tablist"]')?.getAttribute('aria-labelledby') === heading.id;
      el?.click();
      const panel = await until(() => {
        const p = document.getElementById('settings-panel-' + tab);
        return p && !p.hidden && el.getAttribute('aria-selected') === 'true' && p.innerText.trim().length > 20
          && !/^Loading/.test(p.innerText.trim()) ? p : null;
      });
      visited.push({ tab, inGroup, shown: !!panel, text: panel ? panel.innerText.slice(0, 40) : document.body.innerText.slice(0, 120) });
    }
    const rules = await api.rules.getLatest(unit.id);
    const ruleId = rules.configs[rules.configs.length - 1].ruleId;
    location.hash = '#/';
    await waitFor('[data-testid="stat-card"]');
    location.hash = '#/settings?tab=rules&rule=' + ruleId;
    const card = await until(() => document.querySelector('[data-testid="rule-card-' + ruleId + '"]'));
    await new Promise((r) => setTimeout(r, 600));
    const rect = card ? card.getBoundingClientRect() : null;
    const selected = document.getElementById('settings-tab-rules')?.getAttribute('aria-selected');
    const tabOnly = await (async () => {
      location.hash = '#/';
      await waitFor('[data-testid="stat-card"]');
      location.hash = '#/settings?tab=backups';
      return !!(await until(() => document.getElementById('settings-tab-backups')?.getAttribute('aria-selected') === 'true'));
    })();
    return {
      visited, ruleId, selected, cardShown: !!card,
      cardOnScreen: !!rect && rect.bottom > 0 && rect.top < window.innerHeight, tabOnly,
    };
  })()`;

/**
 * `capturePage` straight after a reload fails with `UnknownVizError`: the new document has no
 * compositor surface until its first frame is presented, and viz cannot copy from a surface it
 * does not have yet. Measured at 840x440 with 300 back-to-back captures and a reload every 50:
 * every failure fell on the capture(s) right after a reload (up to two in a row), none in the
 * 300 captures without a reload, whatever the scrolling. It is how long the first frame takes, not
 * the app: the grid does not re-layout (zero `fit` calls over ten frames before the capture).
 * `invalidate()` asks for a fresh frame; any other error, or no frame within the limit, still fails.
 */
async function captureAfterFirstFrame(win: BrowserWindow, limitMs = 5000): Promise<NativeImage> {
  const started = Date.now();
  for (;;) {
    try {
      return await win.webContents.capturePage();
    } catch (err) {
      if (!String(err).includes('UnknownVizError') || Date.now() - started > limitMs) throw err;
      win.webContents.invalidate();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export function runSmoke(win: BrowserWindow): void {
  const timer = setTimeout(() => fail(`did not finish within ${TIMEOUT_MS}ms`), TIMEOUT_MS);

  win.webContents.on('render-process-gone', (_e, details) =>
    fail(`renderer gone: ${details.reason}`),
  );
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') fail(`renderer console error: ${event.message}`);
  });

  win.webContents.once('did-finish-load', async () => {
    try {
      const bridge = await win.webContents.executeJavaScript(
        `typeof window.shiftnurse?.units?.list === 'function'`,
      );
      if (!bridge) fail('window.shiftnurse not installed by preload');

      const welcome = (await win.webContents.executeJavaScript(WELCOME_SCRIPT)) as {
        before: string;
        welcome: number;
        choices: number;
        demos: number;
        dashboard: number;
        after: string;
        mode: string | undefined;
        unit: string | undefined;
      };
      if (welcome.before !== 'welcome' || welcome.welcome === 0) {
        fail(`an empty database did not open on the welcome screen: ${JSON.stringify(welcome)}`);
      }
      if (welcome.choices !== 3) fail(`welcome offers ${welcome.choices} choices, expected 3`);
      if (welcome.demos !== 3) fail(`the demo list offers ${welcome.demos} units, expected 3`);
      if (welcome.dashboard === 0 || welcome.after !== 'ready' || welcome.mode !== 'demo') {
        fail(`"Explore the demo" did not reach the dashboard: ${JSON.stringify(welcome)}`);
      }
      if (welcome.unit !== '5 North Medical-Surgical') {
        fail(`picking the community demo loaded "${welcome.unit}"`);
      }
      console.log(
        `[smoke] first run OK (welcome screen → ${welcome.demos} demo units → ${welcome.unit} → dashboard)`,
      );

      // The guide is reopened through the raw bridge, which bypasses the renderer's cache
      // invalidation, so reload before walking it.
      await win.webContents.executeJavaScript(GUIDE_SCRIPT);
      const reloaded = new Promise<void>((resolve) =>
        win.webContents.once('did-finish-load', () => resolve()),
      );
      win.webContents.reload();
      await reloaded;
      const guide = (await win.webContents.executeJavaScript(GUIDE_WALK_SCRIPT)) as {
        visited: string[];
        stuckAt?: number;
        body?: string;
        dashboard?: number;
        after?: string;
        hash?: string;
      };
      if (guide.stuckAt !== undefined) {
        fail(`setup guide stuck at step ${guide.stuckAt}; body: ${guide.body}`);
      }
      if (guide.visited.length !== SETUP_STEPS.length) {
        fail(`setup guide showed ${guide.visited.length} steps, expected ${SETUP_STEPS.length}`);
      }
      if (guide.dashboard === 0 || guide.after !== 'ready' || guide.hash !== '#/') {
        fail(`finishing the setup guide did not open the dashboard: ${JSON.stringify(guide)}`);
      }
      console.log(`[smoke] setup guide OK (${guide.visited.length} steps → dashboard)`);

      for (const route of ROUTES) {
        const result = (await win.webContents.executeJavaScript(
          visitScript(route.hash, route.testId),
        )) as { found: number; text: string };
        if (result.found === 0) {
          fail(`${route.hash} rendered no [data-testid=${route.testId}]; body: ${result.text}`);
        }
        console.log(`[smoke] ${route.hash} OK (${result.found} × ${route.testId})`);
        // `--screenshot dir/` captures every route as dir/<route>.png for a visual check.
        const shotDir = process.env.SHIFTNURSE_SMOKE_SCREENSHOT;
        if (shotDir?.endsWith('/')) {
          const image = await win.webContents.capturePage();
          const name = route.hash === '#/' ? 'dashboard' : route.hash.slice(2);
          writeFileSync(`${shotDir}${name}.png`, image.toPNG());
        }
      }

      const write = (await win.webContents.executeJavaScript(WRITE_SCRIPT)) as {
        before: number;
        after: number;
        csvHasNurse: boolean;
        violations: number;
        rules: number;
        validateMs: number;
      };
      if (write.after !== write.before + 1) fail(`nurse create: ${write.before} -> ${write.after}`);
      if (!write.csvHasNurse) fail('exported CSV does not contain the created nurse');
      console.log(`[smoke] write path OK (${write.before} -> ${write.after} nurses, CSV export)`);
      if (write.rules < 0) fail('no draft period to validate');
      console.log(
        `[smoke] validate OK (${write.rules} rules, ${write.violations} violations, ${write.validateMs}ms)`,
      );

      const rest = (await win.webContents.executeJavaScript(REST_SCRIPT)) as {
        before: number;
        after: number;
        flagged: boolean;
        message: string;
      };
      if (!rest.flagged) fail(`night-to-day turnaround not flagged: ${rest.message}`);
      console.log(`[smoke] live validation OK — ${rest.message}`);

      const fairness = (await win.webContents.executeJavaScript(FAIRNESS_SCRIPT)) as {
        scored: number;
        badScore: string | null;
        gini: number;
        trendPoints: number;
        before: number;
        after: number;
        nurse: string;
        imported: { periodsImported: number; entriesWritten: number; entriesReplaced: number };
      };
      if (fairness.scored === 0) fail('fairness report scored no nurses');
      if (fairness.badScore)
        fail(`fairness score out of range or incomplete for ${fairness.badScore}`);
      if (fairness.trendPoints === 0) fail('fairness trend has no points from seeded history');
      if (fairness.after > fairness.before + 1e-9) {
        fail(
          `an extra night raised ${fairness.nurse}'s score ${fairness.before} -> ${fairness.after}`,
        );
      }
      if (fairness.imported.periodsImported !== 1 || fairness.imported.entriesWritten !== 1) {
        fail(
          `history import wrote ${JSON.stringify(fairness.imported)}, expected 1 period / 1 entry`,
        );
      }
      console.log(
        `[smoke] fairness OK (${fairness.scored} scored, gini ${fairness.gini.toFixed(3)}, ${fairness.trendPoints} trend points; ${fairness.nurse} ${fairness.before} -> ${fairness.after} after an extra night; import ${fairness.imported.entriesWritten} row)`,
      );
      const cost = (await win.webContents.executeJavaScript(COST_SCRIPT)) as {
        historyTotal: number;
        historyHours: number;
        historyUnpriced: number;
        historyRatio: number | null;
        historyOvertimeNurses: number;
        beforeTotal: number;
        afterTotal: number;
        budgetSet: number;
        budgetRead: number | null;
      };
      if (!(cost.historyTotal > 0)) fail('published period priced to $0');
      if (cost.historyUnpriced !== 0) fail(`${cost.historyUnpriced} seeded shifts unpriced`);
      if (cost.historyRatio === null || cost.historyRatio < 0.9 || cost.historyRatio > 1.1) {
        fail(`published period budget ratio ${cost.historyRatio} is not near the seeded budget`);
      }
      if (!(cost.afterTotal > cost.beforeTotal)) {
        fail(`adding a shift left the draft total at ${cost.beforeTotal} -> ${cost.afterTotal}`);
      }
      if (cost.budgetRead !== cost.budgetSet) {
        fail(`budget round-trip wrote ${cost.budgetSet} but read ${cost.budgetRead}`);
      }
      console.log(
        `[smoke] cost OK (published $${Math.round(cost.historyTotal)} for ${cost.historyHours}h at ${(cost.historyRatio * 100).toFixed(1)}% of budget, ${cost.historyOvertimeNurses} nurses with OT; draft $${Math.round(cost.beforeTotal)} -> $${Math.round(cost.afterTotal)} after one shift)`,
      );
      const solved = (await win.webContents.executeJavaScript(SOLVER_SCRIPT)) as {
        solver: string;
        fellBackFrom?: { solver: string; reason: string };
        batchCheck: {
          runs: string[];
          columns: number;
          previewShifts: number;
          previewValidated: boolean;
        };
        orTools: boolean;
        windows: { tried: number; improved: number } | null;
        others: {
          id: string;
          state: string;
          error?: string;
          solver: string | null;
          created: number;
          unfilled: number;
          gap: number | null;
          total: number | null;
          elapsedMs: number;
          identical: boolean;
          nurseLevel: string[];
        }[];
        state: string;
        error?: string;
        applied?: { created: number; preservedLocked: number };
        progressSeen: number;
        seed: number;
        unfilled: number;
        hard: number;
        elapsedMs: number;
        written: number;
        lockedKept: boolean | null;
        nurseLevel: string[];
        identical: boolean;
        secondState: string;
        paths: unknown[];
      };
      if (solved.state !== 'done') fail(`solve ended ${solved.state}: ${solved.error ?? ''}`);
      if (!solved.applied || solved.applied.created === 0) fail('solve wrote no assignments');
      if (solved.progressSeen === 0) fail('no progress reports arrived from the solver worker');
      if (solved.lockedKept === false) fail('the locked assignment did not survive Generate');
      if (solved.nurseLevel.length > 0) {
        fail(`generated schedule breaks a nurse-level rule: ${solved.nurseLevel.join(' | ')}`);
      }
      if (!solved.identical) {
        fail(
          `regenerating unchanged inputs changed the schedule (second run ${solved.secondState}; ` +
            `solved as ${JSON.stringify(solved.paths)})`,
        );
      }
      const batch = solved.batchCheck;
      if (batch.runs.join() !== 'done,done' || batch.columns !== 2) {
        fail(`a batch of two finished as [${batch.runs}] with ${batch.columns} comparable options`);
      }
      if (batch.previewShifts === 0 || !batch.previewValidated) {
        fail('previewing option 2 returned no shifts or no validation');
      }
      // The demo unit is on the default solver (hybrid). Without the OR-Tools runner the job must
      // fall back to SA + LNS *and say so*; a silent substitution is the failure being guarded.
      if (
        !solved.orTools &&
        (solved.solver !== 'sa-lns' || solved.fellBackFrom?.solver !== 'hybrid')
      ) {
        fail(`expected a reported fallback from hybrid to sa-lns, got ${solved.solver}`);
      }
      if (solved.orTools && solved.solver !== 'hybrid') {
        fail(
          `with the OR-Tools runner installed the demo unit should generate with hybrid, got ${solved.solver}`,
        );
      }
      for (const o of solved.others) {
        if (o.state !== 'done' || o.solver !== o.id) {
          fail(`${o.id} solve ended ${o.state} (${o.solver}): ${o.error ?? ''}`);
        }
        if (o.nurseLevel.length > 0)
          fail(`${o.id} breaks a nurse-level rule: ${o.nurseLevel.join(' | ')}`);
        if (!o.identical) fail(`${o.id}: regenerating unchanged inputs changed the schedule`);
        console.log(
          `[smoke] ${o.id} OK (${o.created} shifts in ${o.elapsedMs}ms, objective ${o.total}, ${o.unfilled} unfilled${o.gap === null ? '' : `, gap ${(o.gap * 100).toFixed(0)}%`}, regenerate identical)`,
        );
      }
      console.log(
        `[smoke] solver OK (${solved.solver}${solved.fellBackFrom ? ` after falling back from ${solved.fellBackFrom.solver}` : ''}${solved.windows ? `, ${solved.windows.improved}/${solved.windows.tried} CP-SAT windows improved` : ''}, ${solved.applied.created} shifts in ${solved.elapsedMs}ms, seed ${solved.seed}, ${solved.unfilled} unfilled, ${solved.hard} hard violations, locked kept: ${solved.lockedKept}, regenerate identical)`,
      );
      const pay = (await win.webContents.executeJavaScript(PAY_TAB_SCRIPT)) as {
        rows: number;
        differentials: number;
      };
      if (pay.rows < 2 || pay.differentials < 2) {
        fail(
          `Settings › Pay rendered ${pay.rows} rate rows and ${pay.differentials} differentials`,
        );
      }
      console.log(
        `[smoke] pay settings OK (${pay.rows} rates, ${pay.differentials} differentials)`,
      );
      const solverTab = (await win.webContents.executeJavaScript(SOLVER_TAB_SCRIPT)) as {
        options: number;
        checked: string | null;
        unavailable: number;
      };
      if (solverTab.options !== 3 || solverTab.checked !== 'hybrid') {
        fail(
          `Settings › Solver rendered ${solverTab.options} options with ${solverTab.checked} checked`,
        );
      }
      console.log(
        `[smoke] solver settings OK (3 options, hybrid checked, ${solverTab.unavailable} unavailable)`,
      );
      const groups = (await win.webContents.executeJavaScript(SETTINGS_GROUPS_SCRIPT)) as {
        visited: { tab: string; inGroup: boolean; shown: boolean; text: string }[];
        ruleId: string;
        selected: string | null | undefined;
        cardShown: boolean;
        cardOnScreen: boolean;
        tabOnly: boolean;
      };
      for (const v of groups.visited) {
        if (!v.inGroup) fail(`Settings tab "${v.tab}" is not in its group's tablist`);
        if (!v.shown) fail(`clicking Settings › ${v.tab} showed no panel; page reads: ${v.text}`);
      }
      if (groups.selected !== 'true' || !groups.cardShown) {
        fail(
          `#/settings?tab=rules&rule=${groups.ruleId} did not open the Rules panel on that rule's card`,
        );
      }
      if (!groups.cardOnScreen)
        fail(`the deep link did not scroll rule ${groups.ruleId} into view`);
      if (!groups.tabOnly) fail('#/settings?tab=backups did not open Backups');
      console.log(
        `[smoke] settings groups OK (${groups.visited.map((v) => v.tab).join(', ')} by click, one per group; deep links open Rules at ${groups.ruleId} and Backups)`,
      );
      const grid = (await win.webContents.executeJavaScript(GRID_KEYBOARD_SCRIPT)) as {
        error?: string;
        tabStops: number;
        expectedStops: number;
        chips: number;
        moved?: string;
        pickerOpened: boolean;
        focusInPicker: boolean;
        options: number;
        pickerClosed: boolean;
        focusBack?: string;
      };
      if (
        grid.error ||
        grid.tabStops !== grid.expectedStops ||
        grid.moved !== '0:1' ||
        !grid.pickerOpened ||
        !grid.focusInPicker ||
        grid.options === 0 ||
        !grid.pickerClosed ||
        grid.focusBack !== '0:1'
      ) {
        fail(`schedule grid keyboard path broken: ${JSON.stringify(grid)}`);
      }
      console.log(
        `[smoke] grid keyboard OK (${grid.tabStops} tab stop(s) among ${grid.chips} chips, arrows move, Enter opens ${grid.options} shift types, Escape returns focus)`,
      );
      const uiShotDir = process.env.SHIFTNURSE_SMOKE_SCREENSHOT;
      const uiShot = async (name: string) => {
        if (uiShotDir?.endsWith('/')) {
          await new Promise((r) => setTimeout(r, 300));
          writeFileSync(`${uiShotDir}${name}.png`, (await win.webContents.capturePage()).toPNG());
        }
      };
      const run = (script: string) => win.webContents.executeJavaScript(script);
      const started = (await run(GENERATE_UI_STEPS.start)) as { error?: string; estimate?: string };
      if (started.error) fail(`Generate from the page: ${started.error}`);
      const summary = (await run(GENERATE_UI_STEPS.summary)) as {
        runs: number;
        names: string[];
        gridBest: boolean;
      } | null;
      if (summary?.runs !== 3) {
        fail(`three options generated from the page summarised as ${JSON.stringify(summary)}`);
      }
      await uiShot('generate-summary');

      const reopened = (await run(GENERATE_UI_STEPS.reopen)) as {
        finished: boolean;
        setup: boolean;
      } | null;
      if (!reopened?.finished || reopened.setup) {
        fail(`reopening Generate after a finished run showed ${JSON.stringify(reopened)}`);
      }
      await uiShot('generate-reopened');
      const previewed = (await run(GENERATE_UI_STEPS.preview)) as {
        banner: string;
        outlined: number;
        tagged: number;
      } | null;
      if (!previewed) {
        fail(
          'previewing an option outlined no shifts that differ from the draft, or left a readout above the grid on the draft',
        );
      }
      await uiShot('generate-preview');
      const compared = (await run(GENERATE_UI_STEPS.compare)) as {
        rows: number;
        columns: number;
      } | null;
      // A label column, the grid's column and one per variation.
      if (compared?.columns !== 5) {
        fail(`the comparison table rendered ${JSON.stringify(compared)}, expected 5 columns`);
      }
      await uiShot('generate-compare');
      const more = (await run(GENERATE_UI_STEPS.more)) as {
        checked: boolean;
        label: string;
        names: string[];
        carried: boolean;
      } | null;
      if (more?.carried) fail('a preview of the previous batch carried over into Generate more');
      // The next three numbers after the batch it followed: new seeds, not a repeat.
      const last = Number(summary!.names.at(-1)?.replace('Option ', ''));
      const expected = [1, 2, 3].map((k) => `Option ${last + k}`).join();
      if (!more?.checked || more.names.join() !== expected) {
        fail(
          `Generate more after ${summary!.names.join(', ')} gave ${JSON.stringify(more)}, expected ${expected}`,
        );
      }
      await uiShot('generate-more');
      const savedCandidate = (await run(SAVE_CANDIDATE_SCRIPT)) as {
        error?: string;
        saved: number;
        text: string;
        changed: boolean;
        savedIndex: number | null;
        before: number;
        after: number;
      };
      if (savedCandidate.error) fail(`save from the candidates bar: ${savedCandidate.error}`);
      if (savedCandidate.saved === 0) {
        fail('pressing Save on the candidates bar never showed "Saved — this is the draft now"');
      }
      if (!savedCandidate.changed || savedCandidate.savedIndex === null) {
        fail(
          `the candidates bar said saved but the draft is unchanged (${JSON.stringify(savedCandidate)})`,
        );
      }
      console.log(
        `[smoke] generate save OK (Save on the bar wrote the option to the draft: ${savedCandidate.before} -> ${savedCandidate.after} shifts, bar reads "${savedCandidate.text.trim()}")`,
      );
      const discarded = (await run(GENERATE_UI_STEPS.discard)) as { gone: boolean } | null;
      if (!discarded) fail('discarding the options left the candidates bar up');
      console.log(
        `[smoke] generate UI OK (${started.estimate}; summary of ${summary!.runs} with ${summary!.gridBest ? 'the grid' : 'an option'} best, reopens on the summary; preview outlines ${previewed!.outlined} changed shifts with ${previewed!.tagged} readouts on the option; compare ${compared!.rows} rows × ${compared!.columns - 2} options; "${more!.label}" after ${summary!.names.at(-1)} gave ${more!.names.join(', ')}; discarded)`,
      );
      // The save above went through the UI, but the bridge writes before it did not: start the
      // undo check from a cold grid so the chips it drags are the saved draft's.
      const reload = async () => {
        const loaded = new Promise<void>((resolve) =>
          win.webContents.once('did-finish-load', () => resolve()),
        );
        win.webContents.reload();
        await loaded;
      };
      await reload();
      const undone = (await run(UNDO_MOVE_SCRIPT)) as {
        error?: string;
        added?: number;
        removed?: number;
        restored?: boolean;
        total?: number;
      };
      if (undone.error) fail(`undo after a move: ${undone.error}`);
      if (undone.added !== 1 || undone.removed !== 1) {
        fail(
          `one drag changed ${undone.added} added / ${undone.removed} removed shifts, expected 1 / 1`,
        );
      }
      if (!undone.restored) {
        fail('Undo after a move did not put the shift back on its nurse, day and shift type');
      }
      console.log(
        `[smoke] undo OK (dragged one of ${undone.total} shifts to an empty day, Undo toast put it back on its nurse, day and shift)`,
      );
      const requests = (await win.webContents.executeJavaScript(REQUESTS_SCRIPT)) as {
        error?: string;
        status: string;
        impactDecision: string;
        competing: number;
        hasSummary: boolean;
        conflicts: number;
        resolutions: number;
        policyEnabled: boolean;
        autoApplied: number;
        denyWithoutReason: boolean;
      };
      if (requests.error) fail(`requests: ${requests.error}`);
      if (requests.status !== 'pending') fail(`created request is ${requests.status}`);
      if (requests.impactDecision !== 'approved')
        fail('timeOff.impact returned the wrong decision');
      if (!requests.hasSummary) fail('conflicts.analyse returned no summary');
      if (requests.policyEnabled) fail('auto-resolve policy is on by default');
      if (requests.autoApplied !== 0) {
        fail(`auto-resolve applied ${requests.autoApplied} resolutions with the policy off`);
      }
      if (!requests.denyWithoutReason) fail('a denial with a blank reason was accepted');
      console.log(
        `[smoke] requests OK (impact simulated, ${requests.conflicts} conflicts / ${requests.resolutions} options, auto-resolve off applied 0, blank denial refused)`,
      );
      const leavePrep = (await run(LEAVE_PREPARE_SCRIPT)) as {
        error?: string;
        periodId: string;
        requestId: string;
        nurseId: string;
        freed: { id: string; date: string; shiftTypeId: string }[];
      };
      if (leavePrep.error) fail(`leave with cover: ${leavePrep.error}`);
      // The request was filed through the bridge, so the page must start from a cold cache.
      await reload();
      const leaveUi = (await run(LEAVE_UI_SCRIPT)) as {
        error?: string;
        chosen: string[];
        closed: boolean;
        picks: number;
      };
      if (leaveUi.error) fail(`leave with cover: ${leaveUi.error}`);
      if (!leaveUi.closed) fail('"Approve and cover" left the decide dialog open');
      const leaveAfter = (await run(
        leaveCheckScript(
          leavePrep.requestId,
          leavePrep.periodId,
          leavePrep.freed.map((f) => f.id),
        ),
      )) as {
        status: string;
        freedGone: boolean;
        assignments: { id: string; nurseId: string; date: string; shiftTypeId: string }[];
      };
      if (leaveAfter.status !== 'approved') {
        fail(`the request is ${leaveAfter.status} after "Approve and cover", expected approved`);
      }
      if (!leaveAfter.freedGone) fail('the nurse’s shift is still on the schedule after approval');
      if (leaveUi.chosen.length === 0) fail('the decide dialog offered no cover to choose');
      for (const nurseId of leaveUi.chosen) {
        const covered = leavePrep.freed.some((f) =>
          leaveAfter.assignments.some(
            (a) => a.nurseId === nurseId && a.date === f.date && a.shiftTypeId === f.shiftTypeId,
          ),
        );
        if (!covered) fail(`the chosen cover ${nurseId} has no shift on the freed day`);
      }
      console.log(
        `[smoke] leave cover OK (Review dialog freed ${leavePrep.freed.length} shift(s), ${leaveUi.chosen.length} cover(s) chosen from the list, request approved, cover shifts on the schedule)`,
      );
      const exchange = (await win.webContents.executeJavaScript(EXCHANGE_SCRIPT)) as {
        error?: string;
        verdict?: string;
        blockers?: string[];
        proposedStatus?: string;
        decidedStatus?: string;
        decideError?: string;
        blankDenyRefused: boolean;
      };
      if (exchange.error) fail(`exchange: ${exchange.error}`);
      if (typeof exchange.verdict !== 'string') fail('exchange.evaluate returned no verdict');
      if (exchange.proposedStatus !== 'proposed') {
        fail(`proposed exchange is ${exchange.proposedStatus}`);
      }
      if (exchange.decideError) fail(`exchange decision failed: ${exchange.decideError}`);
      if (exchange.decidedStatus !== 'approved' && exchange.decidedStatus !== 'denied') {
        fail(`exchange decision left status ${exchange.decidedStatus}`);
      }
      if (!exchange.blankDenyRefused) fail('a blank-reason exchange denial was accepted');
      console.log(
        `[smoke] exchange OK (verdict ${exchange.verdict}, decided ${exchange.decidedStatus}, blank denial refused${exchange.blockers?.length ? `; blockers: ${exchange.blockers.join(' | ')}` : ''})`,
      );
      const published = (await win.webContents.executeJavaScript(PUBLISH_SCRIPT)) as {
        error?: string;
        periodId: string;
        previewHard: number;
        alertKinds: Record<string, number>;
        previewAdded: number;
        firstVersion: number;
        ledgerEntries: number;
        firstBackup: string | null;
        refused: boolean;
        changeReasons: string[];
        changeAssignment: boolean;
        pendingChanges: number;
        diffAdded: number;
        diffRemoved: number;
        secondVersion: number;
        versions: string[];
        csvHasNurse: boolean;
        publishBackups: number;
        status: string;
      };
      if (published.error) fail(`publish: ${published.error}`);
      if (published.firstVersion !== 1)
        fail(`first publish made version ${published.firstVersion}`);
      if (published.previewAdded === 0) fail('publish preview showed nothing going out');
      if (published.ledgerEntries === 0) fail('publish wrote no fairness ledger rows');
      if (
        !published.firstBackup ||
        !existsSync(`${app.getPath('userData')}/backups/${published.firstBackup}`)
      ) {
        fail(`publish backup missing: ${published.firstBackup}`);
      }
      if (!published.refused)
        fail('an edit to the published schedule without a reason was accepted');
      if (published.changeReasons.join('|') !== 'added:Smoke: cover a call-off') {
        fail(`change log reads ${JSON.stringify(published.changeReasons)}`);
      }
      if (!published.changeAssignment) fail('change log entry does not point at the added shift');
      if (
        published.pendingChanges !== 1 ||
        published.diffAdded !== 1 ||
        published.diffRemoved !== 0
      ) {
        fail(
          `republish preview: ${published.pendingChanges} pending, +${published.diffAdded}/−${published.diffRemoved}`,
        );
      }
      if (published.secondVersion !== 2) fail(`republish made version ${published.secondVersion}`);
      if (published.versions[1] !== '2:1/0/0') fail(`versions: ${published.versions.join(', ')}`);
      if (!published.csvHasNurse) fail('long CSV export lacks the added shift');
      if (published.publishBackups < 2) fail(`${published.publishBackups} publish backups on disk`);
      if (published.status !== 'published') fail(`period is ${published.status} after publish`);
      const pdf = await renderOutput(outputInput(getDb(), published.periodId), 'pdf-grid');
      if (pdf.subarray(0, 4).toString() !== '%PDF') fail('grid PDF did not render');
      const sheets = await renderOutput(outputInput(getDb(), published.periodId), 'pdf-nurses');
      if (sheets.subarray(0, 4).toString() !== '%PDF') fail('nurse-sheet PDF did not render');
      const xlsx = await renderOutput(outputInput(getDb(), published.periodId), 'xlsx');
      if (xlsx.subarray(0, 2).toString() !== 'PK') fail('xlsx export is not a zip');
      // A nurse's grievance record: the same hidden-window PDF path as the grid.
      const recordPeriod = getPeriod(getDb(), published.periodId);
      const recordNurse = recordPeriod
        ? listNursesForUnit(getDb(), recordPeriod.unitId)[0]
        : undefined;
      if (!recordNurse) fail('no nurse to export a record for');
      else {
        const recordDoc = nurseRecordDocument(
          getDb(),
          recordNurse.id,
          addDays(today(), -30),
          today(),
          today(),
        );
        const recordPdf = await htmlToPdf(recordDoc.html, false);
        if (recordPdf.subarray(0, 4).toString() !== '%PDF') fail('nurse record PDF did not render');
        if (!recordDoc.csv.includes('Entries about kept-apart')) fail('record CSV lacks its note');
      }
      console.log(
        `[smoke] publish OK (v1 with ${published.previewHard} hard violations, alerts ${JSON.stringify(published.alertKinds)}, ${published.ledgerEntries} ledger rows, backup ${published.firstBackup}; reasonless edit refused; change log + republish v2 ${published.versions[1]}; grid PDF ${pdf.length}B, sheets PDF ${sheets.length}B, xlsx ${xlsx.length}B)`,
      );
      const dayOf = (await win.webContents.executeJavaScript(dayOfScript(published.periodId))) as {
        error?: string;
        shiftsCount: number;
        hasStaffing: boolean;
        periodMatches: boolean;
        rosterCount: number;
        duplicateRefused: boolean;
        taggedCallOff: boolean;
        openCount: number;
        openViewOk: boolean;
        candidateCount: number;
        excludedCount: number;
        tiers: string[];
        ranks: number[];
        sameRole: boolean;
        disjoint: boolean;
        absentNotListed: boolean;
        excludedReasons: string[];
        allCallout: boolean;
        notCalloutDetail: string;
        acceptedRefused: boolean;
        covered: boolean;
        calloutSource: boolean;
        acceptedLogged: boolean;
        backfillChanges: string[];
        backfillReasonOk: boolean;
        logOutcomes: string[];
        absentGone: boolean;
        replacementPresent: boolean;
        stillOpen: boolean;
        viewHasReplacement: boolean;
        viewAssignmentGone: boolean;
        cancelBlankRefused: boolean;
        cancelled: boolean;
        date: string;
      };
      if (dayOf.error) fail(`day-of: ${dayOf.error}`);
      if (dayOf.shiftsCount === 0) fail('Today summary returned no shifts for the call-off date');
      if (!dayOf.hasStaffing) fail('a shift on the call-off date has no RN staffing check');
      if (!dayOf.periodMatches) fail('Today summary period does not match the published period');
      if (!dayOf.duplicateRefused) fail('a second call-off on the same assignment was accepted');
      if (!dayOf.taggedCallOff) fail('the roster row was not tagged with the new call-off');
      if (dayOf.openCount < 1) fail('reported call-off did not appear among open call-offs');
      if (!dayOf.openViewOk) fail('open call-off view is missing attempts/assignment/nurse');
      if (dayOf.candidateCount === 0) fail('replacement finder found no eligible candidates');
      const tierIndex: Record<string, number> = { straight: 0, overtime: 1, agency: 2 };
      const expectedRanks = dayOf.tiers.map((_, i) => i + 1);
      if (JSON.stringify(dayOf.ranks) !== JSON.stringify(expectedRanks)) {
        fail(`replacement ranks ${JSON.stringify(dayOf.ranks)} are not 1..n`);
      }
      for (let i = 1; i < dayOf.tiers.length; i++) {
        if (tierIndex[dayOf.tiers[i]!]! < tierIndex[dayOf.tiers[i - 1]!]!) {
          fail(
            `replacement list is not ordered straight/overtime/agency: ${dayOf.tiers.join(',')}`,
          );
        }
      }
      if (!dayOf.sameRole) fail('replacement list includes a non-RN candidate for an RN call-off');
      if (!dayOf.disjoint) fail('a nurse appears in both the candidate and excluded lists');
      if (!dayOf.absentNotListed)
        fail('the absent nurse appears in the candidate or excluded list');
      if (!dayOf.allCallout) {
        fail(`a candidate row is not a callout on the call-off date: ${dayOf.notCalloutDetail}`);
      }
      if (!dayOf.acceptedRefused) fail('logCall accepted an "accepted" outcome directly');
      if (!dayOf.covered)
        fail('backfill did not mark the call-off covered with a matching assignment');
      if (!dayOf.calloutSource) fail('backfill assignment is not source: callout');
      if (!dayOf.acceptedLogged) fail('backfill did not log the accepted attempt');
      if (
        JSON.stringify([...dayOf.backfillChanges].sort()) !== JSON.stringify(['added', 'removed'])
      ) {
        fail(`backfill change log entries: ${JSON.stringify(dayOf.backfillChanges)}`);
      }
      if (!dayOf.backfillReasonOk)
        fail('backfill change log reasons are missing or not "Call-off: ..."');
      if (JSON.stringify(dayOf.logOutcomes) !== JSON.stringify(['accepted', 'no_answer'])) {
        fail(
          `call log outcomes ${JSON.stringify(dayOf.logOutcomes)}, expected accepted then no_answer`,
        );
      }
      if (!dayOf.absentGone) fail('the absent nurse’s assignment survived the backfill');
      if (!dayOf.replacementPresent) fail('the replacement assignment is missing from the period');
      if (dayOf.stillOpen) fail('the covered call-off still shows as open');
      if (!dayOf.viewHasReplacement) fail('callOffs view does not show the replacement nurse');
      if (!dayOf.viewAssignmentGone) fail('callOffs view still carries the old assignment');
      if (!dayOf.cancelBlankRefused)
        fail('a call-off cancellation with a blank reason was accepted');
      if (!dayOf.cancelled) fail('call-off cancellation with a reason did not succeed');
      console.log(
        `[smoke] day-of OK (${dayOf.shiftsCount} shifts on ${dayOf.date}, ${dayOf.candidateCount} candidates [${dayOf.tiers.join(',')}], ${dayOf.excludedCount} excluded (${dayOf.excludedReasons.join(' | ')}), backfill via change log)`,
      );
      // The day-of checks wrote through the bridge; Today must read them cold.
      await reload();
      const callOffButton = (await run(CALL_OFF_BUTTON_SCRIPT)) as {
        error?: string;
        picked: string;
        cardShown: boolean;
        cardsBefore: number;
        added: string[];
      };
      if (callOffButton.error) fail(`"Someone called off": ${callOffButton.error}`);
      if (!callOffButton.cardShown) {
        fail('reporting through "Someone called off" showed no new call-off card on Today');
      }
      if (
        callOffButton.added.length !== 1 ||
        !callOffButton.picked.startsWith(callOffButton.added[0]!)
      ) {
        fail(
          `the bridge lists ${JSON.stringify(callOffButton.added)} as new call-offs, picked "${callOffButton.picked}"`,
        );
      }
      console.log(
        `[smoke] someone-called-off OK (picked ${callOffButton.added[0]}, report confirmed, card ${callOffButton.cardsBefore + 1} on Today and the call-off is open on the bridge)`,
      );
      const shotDirAfter = process.env.SHIFTNURSE_SMOKE_SCREENSHOT;
      if (shotDirAfter?.endsWith('/')) {
        // The bridge writes above bypassed the renderer's mutation hooks, so its query cache
        // still holds the empty assignment list. Reload: a cold start must show persisted state.
        await new Promise<void>((resolve) => {
          win.webContents.once('did-finish-load', () => resolve());
          win.webContents.reload();
        });
        const chips = (await win.webContents.executeJavaScript(`
          new Promise((resolve) => {
            location.hash = '#/schedule';
            const started = Date.now();
            const tick = () => {
              const chips = document.querySelectorAll('[data-testid="assignment-chip"]');
              if (chips.length >= 2 || Date.now() - started > 10000) {
                chips[0]?.scrollIntoView({ block: 'center' });
                setTimeout(() => resolve(chips.length), 300);
              } else setTimeout(tick, 100);
            };
            tick();
          })`)) as number;
        if (chips < 2)
          fail(`expected the two smoke assignments as chips on the grid, saw ${chips}`);
        writeFileSync(
          `${shotDirAfter}schedule-after.png`,
          (await captureAfterFirstFrame(win)).toPNG(),
        );
        console.log(`[smoke] grid chips OK (${chips} rendered)`);
      }

      const shot = process.env.SHIFTNURSE_SMOKE_SCREENSHOT;
      if (shot && !shot.endsWith('/')) {
        await win.webContents.executeJavaScript(visitScript('#/', 'stat-card'));
        // Another page, for a visual check at a given window size; the pages have no common test
        // id to wait on, so give the route time to render and its queries to land.
        const shotRoute = process.env.SHIFTNURSE_SMOKE_SCREENSHOT_ROUTE;
        if (shotRoute) {
          await win.webContents.executeJavaScript(
            `new Promise((resolve) => { location.hash = ${JSON.stringify(shotRoute)}; setTimeout(resolve, 2000); })`,
          );
        }
        const image = await win.webContents.capturePage();
        writeFileSync(shot, image.toPNG());
        console.log(`[smoke] screenshot written to ${shot}`);
      }
      clearTimeout(timer);
      // The launcher (scripts/smoke.mjs) passes the run only on this line: an exit code of 0 is
      // not enough, because a main process that crashes on startup shows an error dialog and
      // exits 0 once it is dismissed.
      console.log(SMOKE_PASS_MARKER);
      app.exit(0);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });
}
