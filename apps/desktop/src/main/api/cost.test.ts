/**
 * Pay configuration and the period cost report through the IPC handlers. A budget is the one
 * write a manager does every period, so it must update in place and leave both figures in the
 * audit log; pay rules must refuse a nonsense scope in words.
 */

import { addDays, isoDate } from '@shiftnurse/core';
import { auditHistoryFor } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costApi } from './cost.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

const api = () => costApi(f.handle.db);
const auditsOf = (type: string, id: string) => auditHistoryFor(f.handle.db, type, id);

describe('pay rates', () => {
  it('sets a nurse’s own rate, raises it, and deletes it, auditing each', () => {
    const rate = api().createPayRate({
      nurseId: f.rns[0]!.id,
      role: null,
      hourlyRate: 61,
      effectiveFrom: isoDate('2026-01-01'),
    });
    expect(
      api()
        .payRates(f.seeded.unitId)
        .map((r) => r.id),
    ).toContain(rate.id);
    expect(api().updatePayRate(rate.id, { hourlyRate: 64 }).hourlyRate).toBe(64);
    api().deletePayRate(rate.id);
    expect(
      api()
        .payRates(f.seeded.unitId)
        .some((r) => r.id === rate.id),
    ).toBe(false);
    expect(auditsOf('pay_rate', rate.id).map((a) => a.action)).toEqual([
      'delete',
      'update',
      'create',
    ]);
  });

  it('refuses a rate for both a nurse and a role in words', () => {
    expect(() =>
      api().createPayRate({
        nurseId: f.rns[0]!.id,
        role: 'RN',
        hourlyRate: 50,
        effectiveFrom: isoDate('2026-01-01'),
      }),
    ).toThrow(/nurse or a role, not both/i);
  });

  it('says so when deleting a rate that is not there', () => {
    expect(() => api().deletePayRate('nope')).toThrow(/not found/i);
  });
});

describe('differentials and overtime rules', () => {
  it('adds a weekend premium, changes it and removes it', () => {
    const d = api().createDifferential({
      unitId: f.seeded.unitId,
      kind: 'agency',
      mode: 'flat',
      amount: 12,
      active: true,
    });
    expect(
      api()
        .differentials(f.seeded.unitId)
        .map((x) => x.id),
    ).toContain(d.id);
    expect(api().updateDifferential(d.id, { amount: 15 }).amount).toBe(15);
    api().deleteDifferential(d.id);
    expect(
      api()
        .differentials(f.seeded.unitId)
        .some((x) => x.id === d.id),
    ).toBe(false);
    expect(auditsOf('differential', d.id)).toHaveLength(3);
  });

  it('adds a daily overtime rule, changes its multiplier and removes it', () => {
    const r = api().createOvertimeRule({
      unitId: f.seeded.unitId,
      basis: 'daily',
      thresholdHours: 12,
      multiplier: 1.5,
      active: true,
    });
    expect(
      api()
        .overtimeRules(f.seeded.unitId)
        .map((x) => x.id),
    ).toContain(r.id);
    expect(api().updateOvertimeRule(r.id, { multiplier: 2 }).multiplier).toBe(2);
    api().deleteOvertimeRule(r.id);
    expect(
      api()
        .overtimeRules(f.seeded.unitId)
        .some((x) => x.id === r.id),
    ).toBe(false);
    expect(auditsOf('overtime_rule', r.id)).toHaveLength(3);
  });

  it('says so when removing a differential or an overtime rule that is gone', () => {
    expect(() => api().deleteDifferential('x')).toThrow(/not found/i);
    expect(() => api().deleteOvertimeRule('x')).toThrow(/not found/i);
  });
});

describe('the period budget and cost report', () => {
  it('sets a budget, then changes it in place and keeps the old figure in the audit row', () => {
    const periodId = f.seeded.draftPeriodId;
    const first = api().setBudget(periodId, 90_000);
    const second = api().setBudget(periodId, 95_000);
    expect(second.id).toBe(first.id);
    expect(api().report(periodId).budget?.targetDollars).toBe(95_000);
    const [latest] = auditsOf('budget', first.id);
    expect(latest!.before).toMatchObject({ targetDollars: 90_000 });
    expect(latest!.after).toMatchObject({ targetDollars: 95_000 });
  });

  it('says so when setting a budget for a period that does not exist', () => {
    expect(() => api().setBudget('no-period', 1000)).toThrow(/unknown period/i);
  });

  it('prices the shifts on the grid and compares the total with the budget', () => {
    const periodId = f.seeded.draftPeriodId;
    expect(api().report(periodId).cost.totals.total).toBe(0);
    scheduleApi(f.handle.db).createAssignment({
      periodId,
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date: addDays(f.seeded.draftStart, 1),
    });
    api().setBudget(periodId, 50_000);
    const report = api().report(periodId);
    expect(report.cost.totals.total).toBeGreaterThan(0);
    expect(report.variance).toMatchObject({ targetDollars: 50_000 });
    expect(report.variance!.actualDollars).toBeGreaterThan(0);
    expect(report.variance!.actualDollars).toBeLessThan(50_000);
  });
});
