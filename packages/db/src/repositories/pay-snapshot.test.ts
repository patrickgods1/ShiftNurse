/**
 * A published schedule keeps the pay configuration it went out under. Staff were paid under the
 * differentials, overtime rules and pay settings in force when it was published; a raise agreed in
 * November must not rewrite what October's report says October cost, unless the manager reprices
 * it on purpose, with a reason.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, type Id, isoDate } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { payConfigSnapshot } from '../schema.js';
import { createShiftType, createUnit, updateUnit } from './config.js';
import { createHoliday } from './holidays.js';
import {
  createDifferential,
  createOvertimeRule,
  createPayRate,
  savePaySettings,
  updateDifferential,
} from './pay.js';
import {
  backfillPayConfigSnapshots,
  latestPayConfigSnapshot,
  payConfigFor,
  repricePeriod,
} from './pay-snapshot.js';
import { publishSchedule } from './publish.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { archivePeriod, createAssignment, createPeriod, getPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: Id;
let periodId: Id;
let nightId: Id;
let ana: Id;
let nightDiffId: Id;

beforeEach(() => {
  handle = openTestDatabase();
  const db = handle.db;
  unitId = createUnit(
    db,
    {
      name: '4 West',
      unitType: 'Med-Surg',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  const ruleSet = transact(db, (tx) =>
    saveRuleSet(
      tx,
      {
        unitId,
        name: 'Default',
        weekendDefinition: {
          startWeekday: 6,
          startMinute: 0,
          durationMinutes: 2880,
          mode: 'starts_within',
        },
        fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
        configs: [],
      },
      ACTOR,
    ),
  );
  nightId = createShiftType(
    db,
    {
      unitId,
      name: 'Night 12',
      abbreviation: 'N12',
      startTime: '19:00',
      durationHours: 12,
      isNight: true,
      isOnCall: false,
      color: '#333',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  ana = createNurse(
    db,
    {
      unitId,
      employeeId: 'E1',
      firstName: 'Ana',
      lastName: 'Reyes',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate('2020-01-01'),
      isChargeEligible: true,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  ).id;
  createPayRate(
    db,
    { nurseId: ana, role: null, hourlyRate: 50, effectiveFrom: isoDate('2026-01-01') },
    ACTOR,
  );
  nightDiffId = createDifferential(
    db,
    { unitId, kind: 'night', mode: 'multiplier', amount: 1.1, active: true },
    ACTOR,
  ).id;
  createOvertimeRule(
    db,
    { unitId, basis: 'weekly', thresholdHours: 40, multiplier: 1.5, active: true },
    ACTOR,
  );
  savePaySettings(
    db,
    unitId,
    {
      callBackMinimumHours: 4,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock',
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base',
      compTime: null,
    },
    ACTOR,
  );
  periodId = createPeriod(
    db,
    {
      unitId,
      name: 'October 4–17',
      startDate: isoDate('2026-10-04'),
      endDate: isoDate('2026-10-17'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
  createAssignment(
    db,
    { periodId, nurseId: ana, shiftTypeId: nightId, date: isoDate('2026-10-05') },
    ACTOR,
  );
});

const publish = (reason?: string) =>
  transact(handle.db, (tx) => publishSchedule(tx, { periodId, reason }, ACTOR));

const snapshotRows = () =>
  handle.db.select().from(payConfigSnapshot).where(eq(payConfigSnapshot.periodId, periodId)).all();

describe('the pay configuration a published schedule keeps', () => {
  it('keeps the differentials, overtime rules and pay settings a schedule went out under', () => {
    publish();
    const snap = latestPayConfigSnapshot(handle.db, periodId)!;
    expect(snap.seq).toBe(1);
    expect(snap.periodId).toBe(periodId);
    expect(snap.takenBy).toBe(ACTOR);
    expect(snap.reason).toBeUndefined();
    expect(snap.config.differentials).toHaveLength(1);
    expect(snap.config.differentials[0]).toMatchObject({ kind: 'night', amount: 1.1 });
    expect(snap.config.overtimeRules).toHaveLength(1);
    expect(snap.config.overtimeRules[0]).toMatchObject({
      basis: 'weekly',
      thresholdHours: 40,
      multiplier: 1.5,
    });
    expect(snap.config.paySettings).toEqual({
      callBackMinimumHours: 4,
      premiumStacking: 'compound',
      holidayPayCoversOvertime: false,
      reportingPayNoticeHours: 2,
      overtimeWindowAttribution: 'clock',
      paySpringForwardAsScheduled: false,
      breakPremiumRate: 'base',
      compTime: null,
    });
    expect(snap.config.holidays).toEqual([]);
    const audits = auditHistoryFor(handle.db, 'pay_config_snapshot', periodId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('create');
    expect(audits[0]?.reason).toBeUndefined();
    expect(payConfigFor(handle.db, getPeriod(handle.db, periodId)!)).toEqual(snap.config);
  });

  it('keeps a short-rest premium and consecutive-shift tiers with the schedule', () => {
    const tiers = [
      { fullShiftHours: 8, afterShifts: 6, withinDays: 6 },
      { fullShiftHours: 12, afterShifts: 4, withinDays: 4 },
    ];
    const shortRest = { minHoursOff: 6, scope: 'whole_shift' as const };
    createDifferential(
      handle.db,
      { unitId, kind: 'short_rest', mode: 'multiplier', amount: 1.5, active: true, shortRest },
      ACTOR,
    );
    createDifferential(
      handle.db,
      {
        unitId,
        kind: 'consecutive_shift',
        mode: 'multiplier',
        amount: 1.5,
        active: true,
        consecutive: { afterShifts: 4, withinDays: 4, tiers },
      },
      ACTOR,
    );
    publish();
    const kept = latestPayConfigSnapshot(handle.db, periodId)!.config.differentials;
    expect(kept.find((d) => d.kind === 'short_rest')?.shortRest).toEqual(shortRest);
    expect(kept.find((d) => d.kind === 'consecutive_shift')?.consecutive).toEqual({
      afterShifts: 4,
      withinDays: 4,
      tiers,
    });
  });

  it('reads a snapshot taken before tiers and short rest existed as it was priced then', () => {
    // A row written by an older release: a consecutive-shift premium with no `tiers`, no
    // `shortRest` anywhere. It must read as the 12-hour reading and no short-rest premium.
    publish();
    const taken = latestPayConfigSnapshot(handle.db, periodId)!;
    const old = {
      ...taken.config,
      differentials: [
        {
          id: 'old-consecutive',
          unitId,
          kind: 'consecutive_shift',
          mode: 'multiplier',
          amount: 1.5,
          active: true,
          consecutive: { afterShifts: 4, withinDays: 4 },
        },
      ],
    };
    handle.db
      .insert(payConfigSnapshot)
      .values({
        id: 'old-snapshot',
        periodId,
        seq: 2,
        takenAt: taken.takenAt,
        takenBy: ACTOR,
        reason: 'older release',
        config: old,
      })
      .run();
    const differentials = payConfigFor(handle.db, getPeriod(handle.db, periodId)!)!.differentials;
    expect(differentials).toEqual(old.differentials);
    expect(differentials[0]?.consecutive?.tiers).toBeUndefined();
    expect(differentials[0]?.shortRest).toBeUndefined();
  });

  it('reads a snapshot taken before comp time existed as paying overtime in cash', () => {
    publish();
    const taken = latestPayConfigSnapshot(handle.db, periodId)!;
    const { compTime: _omitted, ...oldSettings } = taken.config.paySettings;
    handle.db
      .insert(payConfigSnapshot)
      .values({
        id: 'pre-comp-time',
        periodId,
        seq: 2,
        takenAt: taken.takenAt,
        takenBy: ACTOR,
        reason: 'older release',
        config: { ...taken.config, paySettings: oldSettings },
      })
      .run();
    const kept = payConfigFor(handle.db, getPeriod(handle.db, periodId)!)!;
    expect(kept.paySettings.compTime).toBeNull();
  });

  it('prices a draft with today’s settings, so it has no kept configuration', () => {
    expect(payConfigFor(handle.db, getPeriod(handle.db, periodId)!)).toBeUndefined();
    expect(latestPayConfigSnapshot(handle.db, periodId)).toBeUndefined();
  });

  it('does not take a second snapshot when the schedule is republished', () => {
    publish();
    createAssignment(
      handle.db,
      { periodId, nurseId: ana, shiftTypeId: nightId, date: isoDate('2026-10-07') },
      ACTOR,
      'Ana picked up Wednesday night',
    );
    publish('Ana picked up Wednesday night');
    expect(latestPayConfigSnapshot(handle.db, periodId)?.seq).toBe(1);
    expect(snapshotRows()).toHaveLength(1);
  });

  it('records the unit’s holiday attribution with the snapshot', () => {
    transact(handle.db, (tx) => updateUnit(tx, unitId, { holidayAttribution: 'clock' }, ACTOR));
    publish();
    expect(latestPayConfigSnapshot(handle.db, periodId)?.config.holidayAttribution).toBe('clock');
  });

  it('keeps only the holidays near the schedule', () => {
    createHoliday(
      handle.db,
      {
        unitId,
        date: isoDate('2026-10-12'),
        name: 'Columbus Day',
        isMajor: false,
        pairedHolidayId: null,
      },
      ACTOR,
    );
    createHoliday(
      handle.db,
      {
        unitId,
        date: isoDate('2026-12-25'),
        name: 'Christmas',
        isMajor: true,
        pairedHolidayId: null,
      },
      ACTOR,
    );
    publish();
    // The leave window runs 2026-08-23 to 2026-10-31, so Christmas is too far out.
    expect(latestPayConfigSnapshot(handle.db, periodId)?.config.holidays).toEqual([
      { date: '2026-10-12', isMajor: false },
    ]);
  });
});

describe('repricing a published schedule', () => {
  it('refuses to reprice a draft, an archived schedule, or without a reason', () => {
    expect(() =>
      transact(handle.db, (tx) => repricePeriod(tx, periodId, ACTOR, 'Contract change')),
    ).toThrow('"October 4–17" is a draft; a draft is always priced with today’s pay settings.');
    expect(snapshotRows()).toHaveLength(0);

    publish();
    expect(() => transact(handle.db, (tx) => repricePeriod(tx, periodId, ACTOR, '   '))).toThrow(
      'Repricing "October 4–17" needs a reason: staff were paid under the settings it was published with.',
    );
    expect(snapshotRows()).toHaveLength(1);

    transact(handle.db, (tx) => archivePeriod(tx, periodId, ACTOR, 'Closed pay period'));
    expect(() =>
      transact(handle.db, (tx) => repricePeriod(tx, periodId, ACTOR, 'Contract change')),
    ).toThrow('"October 4–17" is archived; its pay record cannot be changed.');
    expect(snapshotRows()).toHaveLength(1);
    expect(auditHistoryFor(handle.db, 'pay_config_snapshot', periodId)).toHaveLength(1);
  });

  it('says so when the schedule to reprice is gone', () => {
    expect(() => transact(handle.db, (tx) => repricePeriod(tx, 'per_gone', ACTOR, 'x'))).toThrow(
      'Schedule period per_gone not found',
    );
  });

  it('reprices a published schedule with a reason, keeping the old settings on the record', () => {
    publish();
    updateDifferential(handle.db, nightDiffId, { amount: 1.2 }, ACTOR);
    // A configuration save alone never reprices a published schedule.
    expect(latestPayConfigSnapshot(handle.db, periodId)?.config.differentials[0]?.amount).toBe(1.1);

    const repriced = transact(handle.db, (tx) =>
      repricePeriod(tx, periodId, ACTOR, 'Retroactive raise per 2026 contract'),
    );
    expect(repriced.seq).toBe(2);
    expect(repriced.reason).toBe('Retroactive raise per 2026 contract');
    expect(repriced.config.differentials[0]?.amount).toBe(1.2);
    expect(latestPayConfigSnapshot(handle.db, periodId)?.seq).toBe(2);

    const latest = auditHistoryFor(handle.db, 'pay_config_snapshot', periodId)[0]!;
    expect(latest.reason).toBe('Retroactive raise per 2026 contract');
    expect(
      (latest.before as { differentials: { amount: number }[] }).differentials[0]?.amount,
    ).toBe(1.1);
    expect((latest.after as { seq: number }).seq).toBe(2);
  });
});

describe('schedules published before snapshots were kept', () => {
  it('records the pay settings of schedules published before snapshots existed, once', () => {
    // A raw status write stands in for a file published before snapshots existed: the snapshot
    // table refuses deletes, so the row is never created rather than removed.
    handle.sqlite
      .prepare("UPDATE schedule_period SET status = 'published' WHERE id = ?")
      .run(periodId);
    expect(latestPayConfigSnapshot(handle.db, periodId)).toBeUndefined();

    expect(transact(handle.db, (tx) => backfillPayConfigSnapshots(tx, ACTOR))).toBe(1);
    const snap = latestPayConfigSnapshot(handle.db, periodId)!;
    expect(snap.seq).toBe(1);
    expect(snap.reason).toBe(
      'Taken when ShiftNurse began keeping the pay settings each published schedule was priced under; it holds the settings in force that day.',
    );
    expect(snap.config.differentials[0]?.amount).toBe(1.1);

    expect(transact(handle.db, (tx) => backfillPayConfigSnapshots(tx, ACTOR))).toBe(0);
    expect(snapshotRows()).toHaveLength(1);
  });

  it('leaves drafts alone when recording earlier schedules', () => {
    expect(transact(handle.db, (tx) => backfillPayConfigSnapshots(tx, ACTOR))).toBe(0);
    expect(snapshotRows()).toHaveLength(0);
  });
});
