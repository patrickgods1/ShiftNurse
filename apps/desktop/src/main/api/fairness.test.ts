/**
 * Fairness through the IPC handlers: the report a manager reads for a period, the history and
 * trend behind it, and the history import. The import is the one that writes, so its refusals
 * must leave the ledger exactly as it was — a half-imported year of history would skew every
 * score after it without anyone being told.
 */

import {
  addDays,
  deriveCounters,
  type HistoricalShiftRow,
  isoDate,
  scoreFairness,
} from '@shiftnurse/core';
import {
  approveTimeOff,
  auditHistoryFor,
  createHoliday,
  createNurse,
  createTimeOffRequest,
  deactivateNurse,
  getLatestRuleSet,
  getUnit,
  ledgerSince,
  listNursesForUnit,
  listPeriodsForUnit,
  listPreferencesForUnit,
  saveRuleSet,
  transact,
  updateUnit,
  upsertFairnessLedgerEntry,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { counterContext, periodOrThrow, ruleSetFor, scheduleViewFor } from './context.js';
import { fairnessApi } from './fairness.js';
import { rosterApi } from './roster.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

const SINCE = isoDate('2020-01-01');

// The seeder's own history import is already in the log, so tests compare against a count.
const importAudits = () =>
  auditHistoryFor(f.handle.db, 'fairness_ledger', 'batch').filter((a) => a.action === 'import')
    .length;

describe('a wish to work a holiday in the counters the ledger records', () => {
  it('counts it met for the volunteer who worked the holiday and unmet for the one who did not', () => {
    const { db } = f.handle;
    const unitId = f.seeded.unitId;
    const [ann, bea] = f.rns;
    const date = addDays(f.seeded.draftStart, 5);
    const holiday = createHoliday(
      db,
      { unitId, date, name: 'Founders Day', isMajor: true },
      'test',
    );
    // Each nurse's only preference is the wish, so the hit rate is that wish alone.
    for (const nurse of [ann!, bea!]) {
      rosterApi(db).preferences.replace(nurse.id, [
        { kind: 'holiday_appetite', holidayId: holiday.id, weight: 3 },
      ]);
    }
    const grid = scheduleApi(db);
    const place = (nurseId: string, on: typeof date) =>
      grid.createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId,
        shiftTypeId: f.day.id,
        date: on,
      });
    place(ann!.id, date);
    place(bea!.id, addDays(date, 2));

    const period = periodOrThrow(db, f.seeded.draftPeriodId);
    const counters = deriveCounters(
      scheduleViewFor(db, period, { lookback: false, floated: 'worked' }),
      counterContext(db, unitId, ruleSetFor(db, period), period),
    );
    expect(counters.get(ann!.id)?.preferenceHitRate).toBe(1);
    expect(counters.get(bea!.id)?.preferenceHitRate).toBe(0);
  });
});

describe('counting a published schedule again', () => {
  it('counts holidays the way the schedule was published, after the unit switches to the clock', () => {
    const { db } = f.handle;
    const unitId = f.seeded.unitId;
    const published = listPeriodsForUnit(db, unitId).find((p) => p.status === 'published')!;
    // The scenario unit never chose one, so its history went out under the start-day reading.
    expect(getUnit(db, unitId)?.holidayAttribution).toBeUndefined();
    transact(db, (tx) => updateUnit(tx, unitId, { holidayAttribution: 'clock' }, 'manager'));
    const ruleSet = ruleSetFor(db, published);
    expect(counterContext(db, unitId, ruleSet, published).unit.holidayAttribution).toBeUndefined();
    expect(counterContext(db, unitId, ruleSet).unit.holidayAttribution).toBe('clock');
  });
});

describe('the fairness report for a period', () => {
  it('lists the nights a nurse was scheduled, on the dates they start', () => {
    const grid = scheduleApi(f.handle.db);
    const ann = f.rns[0]!;
    const bea = f.rns[1]!;
    const nightDates = [addDays(f.seeded.draftStart, 1), addDays(f.seeded.draftStart, 3)];
    for (const date of nightDates) {
      grid.createAssignment({
        periodId: f.seeded.draftPeriodId,
        nurseId: ann.id,
        shiftTypeId: f.night.id,
        date,
      });
    }
    grid.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: bea.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 5),
    });

    const report = fairnessApi(f.handle.db).report(f.seeded.draftPeriodId);
    const scoreOf = (id: string) => report.scores.find((s) => s.nurseId === id)!;

    // Hand count from what was placed: Ann has two nights, Bea only a day shift.
    expect(scoreOf(ann.id).occurrences.nights).toEqual(nightDates);
    expect(scoreOf(bea.id).occurrences.nights).toEqual([]);
    for (const s of report.scores) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it('scores every active nurse on the unit, scheduled or not', () => {
    const report = fairnessApi(f.handle.db).report(f.seeded.draftPeriodId);
    expect(report.scores.length).toBeGreaterThanOrEqual(f.rns.length);
    expect(report.scores.map((s) => s.nurseId)).toContain(f.rns[0]!.id);
  });

  it('refuses a period that does not exist', () => {
    expect(() => fairnessApi(f.handle.db).report('nope')).toThrow(
      'That schedule period no longer exists. Reload the page.',
    );
  });
});

describe('fairness history and trend', () => {
  it('returns the ledger and the trend oldest period first', () => {
    const api = fairnessApi(f.handle.db);
    const history = api.history(f.seeded.unitId);
    expect(history.length).toBeGreaterThan(0);
    const starts = history.map((h) => h.periodStart);
    expect(starts).toEqual([...starts].sort());

    const trend = api.trend(f.seeded.unitId);
    expect(trend.length).toBe(new Set(history.map((h) => h.periodId)).size);
    const trendStarts = trend.map((t) => t.periodStart);
    expect(trendStarts).toEqual([...trendStarts].sort());
    for (const point of trend) {
      expect(point.gini).toBeGreaterThanOrEqual(0);
      expect(Object.keys(point.scores).length).toBeGreaterThan(0);
    }
  });
});

describe('the fairness trend', () => {
  // The fixture's history periods are real app periods, so each carries the rule set it was
  // created under. The weights are changed afterwards, as a manager would on the Rules screen.
  function setup() {
    const { db } = f.handle;
    const unitId = f.seeded.unitId;
    const latest = getLatestRuleSet(db, unitId)!;
    const snapshotWeights = latest.fairnessWeights;
    transact(db, (tx) =>
      saveRuleSet(
        tx,
        {
          unitId,
          name: 'Heavier nights',
          configs: latest.configs,
          weekendDefinition: latest.weekendDefinition,
          fairnessWeights: { ...snapshotWeights, nights: 10, weekends: 0 },
        },
        'test',
        { reason: 'test' },
      ),
    );
    return { db, unitId, snapshotWeights };
  }

  it('scores a past period under the rules it was published with, over the nurses who were there', () => {
    const { db, unitId, snapshotWeights } = setup();
    const leaver = f.rns[0]!;
    deactivateNurse(db, leaver.id, 'test');

    const trend = fairnessApi(db).trend(unitId);
    expect(trend.length).toBeGreaterThan(0);
    const rows = ledgerSince(db, unitId, SINCE);
    const latest = getLatestRuleSet(db, unitId)!.fairnessWeights;
    let snapshotMatteredOnce = false;
    for (const point of trend) {
      const here = rows.filter((e) => e.periodId === point.periodId);
      expect(Object.keys(point.scores).sort()).toEqual(here.map((r) => r.nurseId).sort());

      const period = periodOrThrow(db, point.periodId);
      const scoreWith = (weights: typeof snapshotWeights) =>
        scoreFairness({
          nurses: listNursesForUnit(db, unitId).filter((n) => here.some((r) => r.nurseId === n.id)),
          current: new Map(
            here.map((r) => {
              const { id: _i, nurseId: _n, periodId: _p, periodStart: _s, ...counters } = r;
              return [r.nurseId, counters];
            }),
          ),
          history: rows.filter((e) => e.periodStart < point.periodStart),
          scope: { asOf: point.periodStart, periodDays: here[0]!.periodDays, payPeriodDays: 14 },
          preferences: listPreferencesForUnit(db, unitId),
          weights,
        });
      expect(ruleSetFor(db, period).fairnessWeights).toEqual(snapshotWeights);
      const expected = scoreWith(snapshotWeights);
      expect(point.scores).toEqual(
        Object.fromEntries(expected.scores.map((s) => [s.nurseId, s.score])),
      );
      expect(point.gini).toBe(expected.distribution.score.gini);
      if (
        JSON.stringify(scoreWith(latest).scores.map((s) => s.score)) !==
        JSON.stringify(expected.scores.map((s) => s.score))
      ) {
        snapshotMatteredOnce = true;
      }
    }
    // The leaver worked the last period, so she is still in it.
    const lastRows = rows.filter((e) => e.periodId === trend[trend.length - 1]!.periodId);
    expect(lastRows.map((r) => r.nurseId)).toContain(leaver.id);
    // Today's weights would have told a different story, so the snapshot is what was used.
    expect(snapshotMatteredOnce).toBe(true);
  });

  it('refuses to score a period whose ledger rows disagree on its length', () => {
    const { db, unitId } = setup();
    const row = ledgerSince(db, unitId, SINCE).find((e) => e.periodId.length > 0)!;
    const { id: _id, ...input } = row;
    upsertFairnessLedgerEntry(db, { ...input, periodDays: row.periodDays + 7 }, 'test');
    expect(() => fairnessApi(db).trend(unitId)).toThrow(
      `Fairness history for ${row.periodStart} mixes period lengths.`,
    );
  });

  it('leaves out of a past period a nurse who joined later', () => {
    const { db, unitId } = setup();
    const { id: _id, ...template } = f.rns[0]!;
    const newcomer = createNurse(
      db,
      { ...template, employeeId: 'NEW-1', firstName: 'Nia', lastName: 'Newhire' },
      'test',
    );
    const trend = fairnessApi(db).trend(unitId);
    expect(trend.length).toBeGreaterThan(0);
    for (const point of trend) expect(point.scores[newcomer.id]).toBeUndefined();
  });
});

describe('importing historical shifts', () => {
  // A Monday well before the fixture's own history, so the rows land in periods of their own.
  const monday = isoDate('2026-03-02');

  function rowsFor(employeeId: string, abbreviation: string, offsets: number[]) {
    return offsets.map(
      (o): HistoricalShiftRow => ({
        employeeId,
        date: addDays(monday, o),
        shiftAbbreviation: abbreviation,
      }),
    );
  }

  it('writes a ledger row counting the imported nights, and audits the import', () => {
    const api = fairnessApi(f.handle.db);
    const ann = f.rns[0]!;
    const before = ledgerSince(f.handle.db, f.seeded.unitId, SINCE).length;
    const importsBefore = importAudits();

    const summary = api.importHistory(f.seeded.unitId, [
      ...rowsFor(ann.employeeId, f.night.abbreviation, [0, 2]),
      ...rowsFor(ann.employeeId, f.day.abbreviation.toLowerCase(), [4]),
    ]);

    expect(summary.entriesWritten).toBe(1);
    expect(summary.entriesReplaced).toBe(0);
    expect(summary.periodsImported).toBe(1);
    const after = ledgerSince(f.handle.db, f.seeded.unitId, SINCE);
    expect(after.length).toBe(before + 1);
    const row = after.find((e) => e.periodId.startsWith('import:') && e.nurseId === ann.id)!;
    expect(row.nightShifts).toBe(2);

    expect(importAudits()).toBe(importsBefore + 1);
  });

  it('counts imported history as away for the days a nurse was on approved leave', () => {
    const api = fairnessApi(f.handle.db);
    const ann = f.rns[0]!;
    // Leave Wed Mar 4 – Tue Mar 10 straddles a pay-period start. The fixture's pay periods are
    // anchored on 2026-08-23 (the Sunday its history starts), and 168 days (12 periods) before
    // that is Sun Mar 8, so the periods are Feb 22 – Mar 7 and Mar 8 – Mar 21.
    const leave = createTimeOffRequest(
      f.handle.db,
      {
        nurseId: ann.id,
        startDate: isoDate('2026-03-04'),
        endDate: isoDate('2026-03-10'),
        type: 'fmla',
      },
      'manager',
    );
    approveTimeOff(f.handle.db, leave.id, 'manager');

    // Mon Mar 2 falls in the first period, Mon Mar 16 in the second.
    api.importHistory(f.seeded.unitId, rowsFor(ann.employeeId, f.day.abbreviation, [0, 14]));

    const rows = ledgerSince(f.handle.db, f.seeded.unitId, SINCE)
      .filter((e) => e.nurseId === ann.id && e.periodId.startsWith('import:'))
      .map((e) => ({ periodId: e.periodId, periodDays: e.periodDays, available: e.availableDays }));
    expect(rows).toEqual([
      // Away Mar 4, 5, 6, 7: 14 − 4.
      { periodId: 'import:2026-02-22', periodDays: 14, available: 10 },
      // Away Mar 8, 9, 10: 14 − 3.
      { periodId: 'import:2026-03-08', periodDays: 14, available: 11 },
    ]);
  });

  it('replaces a period it already imported rather than doubling it', () => {
    const api = fairnessApi(f.handle.db);
    const rows = rowsFor(f.rns[0]!.employeeId, f.night.abbreviation, [0]);
    api.importHistory(f.seeded.unitId, rows);
    const again = api.importHistory(f.seeded.unitId, rows);
    expect(again.entriesReplaced).toBe(1);
  });

  it('refuses an unknown employee id in words and writes nothing', () => {
    const api = fairnessApi(f.handle.db);
    const before = ledgerSince(f.handle.db, f.seeded.unitId, SINCE).length;
    const importsBefore = importAudits();
    expect(() =>
      api.importHistory(f.seeded.unitId, [
        ...rowsFor(f.rns[0]!.employeeId, f.night.abbreviation, [0]),
        ...rowsFor('NOT-AN-EMPLOYEE', f.night.abbreviation, [1]),
      ]),
    ).toThrow(/Unknown employee id NOT-AN-EMPLOYEE/);
    expect(ledgerSince(f.handle.db, f.seeded.unitId, SINCE)).toHaveLength(before);
    expect(importAudits()).toBe(importsBefore);
  });

  it('refuses an unknown shift abbreviation in words and writes nothing', () => {
    const api = fairnessApi(f.handle.db);
    const before = ledgerSince(f.handle.db, f.seeded.unitId, SINCE).length;
    const importsBefore = importAudits();
    expect(() =>
      api.importHistory(f.seeded.unitId, [
        ...rowsFor(f.rns[0]!.employeeId, f.night.abbreviation, [0]),
        ...rowsFor(f.rns[1]!.employeeId, 'ZZZ', [1]),
      ]),
    ).toThrow(/Unknown shift abbreviation ZZZ/);
    expect(ledgerSince(f.handle.db, f.seeded.unitId, SINCE)).toHaveLength(before);
    expect(importAudits()).toBe(importsBefore);
  });
});
