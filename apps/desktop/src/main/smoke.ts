/**
 * Headless boot check, enabled by `SHIFTNURSE_SMOKE=1`.
 *
 * Electron apps fail in ways unit tests cannot see: a native module built for the wrong ABI,
 * a preload that never ran, a renderer that rendered nothing. This drives the real window
 * through the real IPC bridge — every route, plus one write — and exits non-zero on any
 * failure, so "the app boots and the screens render" is something a script can assert.
 */

import { existsSync, writeFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { outputInput } from './api.js';
import { getDb } from './database.js';
import { renderOutput } from './output.js';

/**
 * The whole run. With the OR-Tools runner installed the solver section generates six times —
 * hybrid (the demo's default) twice, then SA + LNS and CP-SAT twice each — so it needs minutes,
 * not seconds; without the runner it finishes in well under one.
 */
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

export function isSmokeRun(): boolean {
  return process.env.SHIFTNURSE_SMOKE === '1';
}

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
 * The M9 check: Generate runs in a worker thread against the seeded draft, its result lands in
 * the database with locked rows untouched, the grid's own validator finds no nurse-level hard
 * violation in it, and running it again on unchanged inputs writes the identical schedule.
 * A short iteration budget keeps this to a couple of seconds; the property is the same.
 */
/**
 * One Generate. 90 s is generous on a developer machine, where the default (hybrid) solve takes
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
    const run = async (extra = {}) => {
      const job = await api.solver.start(draft.id, { maxIterations: 20000, ...extra });
      const started = Date.now();
      let status = job;
      let progressSeen = 0;
      while (status.state === 'running' || status.state === 'applying') {
        await new Promise((r) => setTimeout(r, 100));
        status = await api.solver.status(job.id);
        if (status.progress) progressSeen++;
        if (Date.now() - started > ${SOLVE_TIMEOUT_MS}) throw new Error('solve did not finish in ${SOLVE_TIMEOUT_MS / 1000}s');
      }
      return { status, progressSeen };
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
      const r = a.status.report;
      others.push({
        id, state: a.status.state, error: a.status.error, solver: r ? r.stats.solver : null,
        created: a.status.applied ? a.status.applied.created : 0,
        unfilled: r ? r.unfilled.length : -1,
        gap: r && r.stats.gap !== undefined ? r.stats.gap : null,
        total: r ? Math.round(r.objective.total) : null,
        elapsedMs: r ? r.stats.elapsedMs : -1,
        identical: b.status.state === 'done' && JSON.stringify(keysA) === JSON.stringify(keysB),
        nurseLevel: v.result.hardViolations.filter((x) =>
          !['understaffed', 'ratio_breach', 'missing_charge_nurse', 'all_novice_shift', 'missing_credential',
            'under_contracted_hours'].includes(x.code)).map((x) => x.message).slice(0, 3),
      });
    }
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
      solver: first.status.solver, fellBackFrom: first.status.fellBackFrom,
      reportSolver: first.status.report ? first.status.report.stats.solver : null,
      orTools: available.filter((a) => a.id !== 'sa-lns').every((a) => a.available),
      others, windows: first.status.report ? first.status.report.stats.windows : null,
      state: first.status.state, error: first.status.error, applied: first.status.applied,
      progressSeen: first.progressSeen, seed: first.status.seed,
      unfilled: first.status.report ? first.status.report.unfilled.length : -1,
      hard: first.status.report ? first.status.report.hardViolations.length : -1,
      elapsedMs: first.status.report ? first.status.report.stats.elapsedMs : -1,
      written: after.length, lockedKept: locked ? after.some((a) => a.id === locked.id && a.isLocked) : null,
      nurseLevel: nurseLevel.map((v) => v.message).slice(0, 3),
      identical: second.status.state === 'done' && JSON.stringify(firstKeys) === JSON.stringify(again),
      // How each default run was actually solved, so a mismatch says whether one of them lost
      // its CP-SAT runner part-way.
      paths: [first, second].map((r) => {
        const st = r.status.report ? r.status.report.stats : null;
        return st ? { solver: st.solver, fellBackFrom: st.fellBackFrom ?? null, windows: st.windows ?? null } : null;
      }),
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
    const allCallout = report.candidates.every(
      (c) => c.assignment.source === 'callout' && c.assignment.date === date,
    );

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
      excludedReasons, allCallout,
      acceptedRefused, covered, calloutSource, acceptedLogged,
      backfillChanges, backfillReasonOk, logOutcomes,
      absentGone, replacementPresent, stillOpen, viewHasReplacement, viewAssignmentGone,
      cancelBlankRefused, cancelled, date,
    };
  })()`;
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
        reportSolver: string | null;
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
      // The demo unit is on the default solver (hybrid). Without the OR-Tools runner the job must
      // fall back to SA + LNS *and say so*; a silent substitution is the failure being guarded.
      if (solved.reportSolver !== solved.solver) {
        fail(`job says ${solved.solver} but the report was produced by ${solved.reportSolver}`);
      }
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
      if (!dayOf.allCallout) fail('a candidate row is not a callout on the call-off date');
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
          (await win.webContents.capturePage()).toPNG(),
        );
        console.log(`[smoke] grid chips OK (${chips} rendered)`);
      }

      const shot = process.env.SHIFTNURSE_SMOKE_SCREENSHOT;
      if (shot && !shot.endsWith('/')) {
        await win.webContents.executeJavaScript(visitScript('#/', 'stat-card'));
        const image = await win.webContents.capturePage();
        writeFileSync(shot, image.toPNG());
        console.log(`[smoke] screenshot written to ${shot}`);
      }
      clearTimeout(timer);
      app.exit(0);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });
}
