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

const TIMEOUT_MS = 30_000;

/** Each route must render an element carrying this test id. */
const ROUTES: readonly { hash: string; testId: string }[] = [
  { hash: '#/', testId: 'stat-card' },
  { hash: '#/roster', testId: 'roster-table' },
  { hash: '#/requests', testId: 'page-header' },
  { hash: '#/schedule', testId: 'schedule-grid' },
  { hash: '#/demand', testId: 'demand-table' },
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
