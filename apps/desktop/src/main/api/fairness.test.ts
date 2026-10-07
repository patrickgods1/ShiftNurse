/**
 * Fairness through the IPC handlers: the report a manager reads for a period, the history and
 * trend behind it, and the history import. The import is the one that writes, so its refusals
 * must leave the ledger exactly as it was — a half-imported year of history would skew every
 * score after it without anyone being told.
 */

import { addDays, deriveCounters, type HistoricalShiftRow, isoDate } from '@shiftnurse/core';
import { auditHistoryFor, createHoliday, ledgerSince } from '@shiftnurse/db';
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
      scheduleViewFor(db, period, { lookback: false }),
      counterContext(db, unitId, ruleSetFor(db, period), period),
    );
    expect(counters.get(ann!.id)?.preferenceHitRate).toBe(1);
    expect(counters.get(bea!.id)?.preferenceHitRate).toBe(0);
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
    expect(() => fairnessApi(f.handle.db).report('nope')).toThrow();
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
