/**
 * Headless boot check, enabled by `SHIFTNURSE_SMOKE=1`.
 *
 * Electron apps fail in ways unit tests cannot see: a native module built for the wrong ABI,
 * a preload that never ran, a renderer that rendered nothing. This drives the real window
 * through the real IPC bridge — every route, plus one write — and exits non-zero on any
 * failure, so "the app boots and the screens render" is something a script can assert.
 */

import { writeFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';

const TIMEOUT_MS = 60_000;

/** Each route must render an element carrying this test id. */
const ROUTES: readonly { hash: string; testId: string }[] = [
  { hash: '#/', testId: 'stat-card' },
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
const SOLVER_SCRIPT = `
  (async () => {
    const api = window.shiftnurse;
    const [unit] = await api.units.list();
    const draft = (await api.periods.list(unit.id)).find((p) => p.status === 'draft');
    const before = await api.periods.assignments(draft.id);
    const pin = before.find((a) => !a.isLocked);
    const locked = pin ? await api.schedule.setLocked(pin.id, true) : undefined;
    const run = async () => {
      const job = await api.solver.start(draft.id, { maxIterations: 20000 });
      const started = Date.now();
      let status = job;
      let progressSeen = 0;
      while (status.state === 'running' || status.state === 'applying') {
        await new Promise((r) => setTimeout(r, 100));
        status = await api.solver.status(job.id);
        if (status.progress) progressSeen++;
        if (Date.now() - started > 40000) throw new Error('solve did not finish in 40s');
      }
      return { status, progressSeen };
    };
    const first = await run();
    const after = await api.periods.assignments(draft.id);
    const key = (a) => a.nurseId + '|' + a.date + '|' + a.shiftTypeId + '|' + (a.isCharge ? 'C' : '');
    const firstKeys = after.map(key).sort();
    const validation = await api.schedule.validate(draft.id);
    const nurseLevel = validation.result.hardViolations.filter((v) =>
      !['understaffed', 'ratio_breach', 'missing_charge_nurse', 'all_novice_shift', 'missing_credential',
        'under_contracted_hours'].includes(v.code));
    const second = await run();
    const again = (await api.periods.assignments(draft.id)).map(key).sort();
    return {
      state: first.status.state, error: first.status.error, applied: first.status.applied,
      progressSeen: first.progressSeen, seed: first.status.seed,
      unfilled: first.status.report ? first.status.report.unfilled.length : -1,
      hard: first.status.report ? first.status.report.hardViolations.length : -1,
      elapsedMs: first.status.report ? first.status.report.stats.elapsedMs : -1,
      written: after.length, lockedKept: locked ? after.some((a) => a.id === locked.id && a.isLocked) : null,
      nurseLevel: nurseLevel.map((v) => v.message).slice(0, 3),
      identical: second.status.state === 'done' && JSON.stringify(firstKeys) === JSON.stringify(again),
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
          `regenerating unchanged inputs changed the schedule (second run ${solved.secondState})`,
        );
      }
      console.log(
        `[smoke] solver OK (${solved.applied.created} shifts in ${solved.elapsedMs}ms, seed ${solved.seed}, ${solved.unfilled} unfilled, ${solved.hard} hard violations, locked kept: ${solved.lockedKept}, regenerate identical)`,
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
