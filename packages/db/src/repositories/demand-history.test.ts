/**
 * The demand rules each unit had in force, kept as an append-only, effective-dated history. A
 * published schedule's staffing was judged short or met under the ratios, tiers and floors of its
 * day; loosening a ratio today must not rewrite that verdict. The tripwire at the top fails when a
 * writer of those tables forgets to record the change: the triggers mark the unit dirty and no
 * version appears.
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  datesInRange,
  type Id,
  isoDate,
  type SolveInput,
} from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { localInstant } from '../local-days.js';
import { demandConfigDirty, demandConfigVersion, unit as unitTable } from '../schema.js';
import { seedDemoUnit } from '../seed/demo.js';
import { seedScenarioUnit } from '../seed/scenarios.js';
import {
  createAcuityTier,
  createRatioRule,
  deactivateRatioRule,
  deleteAcuityTier,
  updateAcuityTier,
  updateRatioRule,
} from './acuity.js';
import { upsertCensusForecasts } from './census.js';
import {
  createShiftType,
  createUnit,
  deactivateShiftType,
  deleteCoverageRequirement,
  duplicateShiftType,
  fillCoverageWeek,
  updateShiftType,
  updateUnit,
  upsertCoverageRequirement,
} from './config.js';
import {
  backfillDemandConfigVersions,
  batchDemandVersions,
  currentDemandConfig,
  demandConfigOn,
  demandInputsForDate,
  demandTableFor,
  latestDemandConfigVersion,
  recordDemandConfigVersion,
} from './demand-history.js';
import { publishSchedule } from './publish.js';
import { saveRuleSet } from './rulesets.js';
import { createPeriod, getPeriod } from './schedule.js';
import { applyJurisdiction, applySetupPreset } from './setup.js';
import { demandInputs, loadPeriodInput } from './solve-input.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: Id;
let tierId: Id;
let ratioId: Id;
let dayId: Id;
let floorId: Id;

const versions = (unit: Id = unitId) =>
  handle.db.select().from(demandConfigVersion).where(eq(demandConfigVersion.unitId, unit)).all();
const dirty = () =>
  handle.db
    .select()
    .from(demandConfigDirty)
    .all()
    .map((r) => r.unitId);
const run = (sql: string, ...params: unknown[]) => handle.sqlite.prepare(sql).run(...params);

function newUnit(name: string): Id {
  return createUnit(
    handle.db,
    {
      name,
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
}

beforeEach(() => {
  handle = openTestDatabase();
  const db = handle.db;
  unitId = newUnit('4 West');
  tierId = createAcuityTier(
    db,
    { unitId, name: 'Standard', level: 1, careHoursPerPatientDay: 6 },
    ACTOR,
  ).id;
  ratioId = createRatioRule(
    db,
    { unitId, role: 'RN', acuityTierId: null, maxPatientsPerNurse: 5, active: true },
    ACTOR,
  ).id;
  dayId = createShiftType(
    db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#0ea5e9',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  floorId = upsertCoverageRequirement(
    db,
    {
      unitId,
      shiftTypeId: dayId,
      weekday: 1,
      date: null,
      role: 'RN',
      minCount: 4,
      targetCount: 5,
    },
    ACTOR,
  ).id;
});

afterEach(() => {
  vi.useRealTimers();
  handle.close();
});

describe('every writer of the demand rules records the version it makes', () => {
  // One row per writer. A writer that forgets `recordDemandConfigVersion` fails here twice over:
  // no new version, and the trigger's dirty mark is left behind.
  const writers: [string, () => void][] = [
    [
      'creating a ratio rule',
      () =>
        createRatioRule(
          handle.db,
          { unitId, role: 'CNA', acuityTierId: null, maxPatientsPerNurse: 10, active: true },
          ACTOR,
        ),
    ],
    [
      'tightening a ratio rule',
      () => updateRatioRule(handle.db, ratioId, { maxPatientsPerNurse: 4 }, ACTOR),
    ],
    [
      'deactivating a ratio rule',
      () => deactivateRatioRule(handle.db, ratioId, ACTOR, 'The unit closed its overflow beds'),
    ],
    [
      'adding an acuity tier',
      () =>
        createAcuityTier(
          handle.db,
          { unitId, name: 'Heavy', level: 2, careHoursPerPatientDay: 9 },
          ACTOR,
        ),
    ],
    [
      'changing an acuity tier',
      () => updateAcuityTier(handle.db, tierId, { careHoursPerPatientDay: 7 }, ACTOR),
    ],
    [
      'deleting an acuity tier nothing cites',
      () => {
        const spare = createAcuityTier(
          handle.db,
          { unitId, name: 'Spare', level: 3, careHoursPerPatientDay: 12 },
          ACTOR,
        );
        const before = versions().length;
        deleteAcuityTier(handle.db, spare.id, ACTOR);
        expect(versions().length).toBeGreaterThan(before);
      },
    ],
    [
      'adding a coverage floor',
      () =>
        upsertCoverageRequirement(
          handle.db,
          {
            unitId,
            shiftTypeId: dayId,
            weekday: 2,
            date: null,
            role: 'RN',
            minCount: 4,
            targetCount: 5,
          },
          ACTOR,
        ),
    ],
    [
      'raising a coverage floor',
      () =>
        upsertCoverageRequirement(
          handle.db,
          {
            id: floorId,
            unitId,
            shiftTypeId: dayId,
            weekday: 1,
            date: null,
            role: 'RN',
            minCount: 5,
            targetCount: 5,
          },
          ACTOR,
        ),
    ],
    ['deleting a coverage floor', () => deleteCoverageRequirement(handle.db, floorId, ACTOR)],
    [
      'filling a coverage week',
      () =>
        transact(handle.db, (tx) =>
          fillCoverageWeek(
            tx,
            { unitId, shiftTypeId: dayId, role: 'CNA', minCount: 1, targetCount: 2 },
            ACTOR,
          ),
        ),
    ],
    [
      'adding a shift type',
      () =>
        createShiftType(
          handle.db,
          {
            unitId,
            name: 'Night 12',
            abbreviation: 'N12',
            startTime: '19:00',
            durationHours: 12,
            isNight: true,
            isOnCall: false,
            color: '#334155',
            sortOrder: 2,
            active: true,
          },
          ACTOR,
        ),
    ],
    [
      'switching a shift type off in its editor',
      () => updateShiftType(handle.db, dayId, { active: false }, ACTOR),
    ],
    ['retiring a shift type', () => deactivateShiftType(handle.db, dayId, ACTOR)],
    [
      'duplicating a shift type',
      () =>
        transact(handle.db, (tx) =>
          duplicateShiftType(tx, dayId, { name: 'Day 12 (2027)', abbreviation: 'D12B' }, ACTOR),
        ),
    ],
    [
      'taking the charge nurse off the bedside',
      () =>
        updateUnit(
          handle.db,
          unitId,
          {
            ratioStaffing: {
              chargeNurseTakesPatients: false,
              breakMinutesPerNurse: 0,
              chargeCoversBreaks: false,
            },
          },
          ACTOR,
        ),
    ],
    [
      'applying the California preset',
      () => transact(handle.db, (tx) => applyJurisdiction(tx, unitId, 'CA', ACTOR)),
    ],
    [
      'applying the 8-hour shift pattern',
      () =>
        transact(handle.db, (tx) =>
          applySetupPreset(tx, unitId, { kind: 'shift-pattern', pattern: '8h' }, ACTOR),
        ),
    ],
    [
      'applying the step-down acuity preset',
      () =>
        transact(handle.db, (tx) =>
          applySetupPreset(tx, unitId, { kind: 'acuity', preset: 'step-down' }, ACTOR),
        ),
    ],
    [
      'applying the coverage quick fill',
      () =>
        transact(handle.db, (tx) =>
          applySetupPreset(
            tx,
            unitId,
            { kind: 'coverage', shiftTypeIds: [dayId], counts: { RN: 6 } },
            ACTOR,
          ),
        ),
    ],
  ];

  it.each(writers)('records a version after %s', (_name, write) => {
    expect(dirty()).toEqual([]);
    const before = versions().length;
    write();
    expect(versions().length).toBeGreaterThan(before);
    expect(dirty()).toEqual([]);
  });
});

describe('a version is recorded only when the demand rules changed', () => {
  it('records nothing when the rules read the same as the last version', () => {
    const before = versions().length;
    expect(recordDemandConfigVersion(handle.db, unitId, ACTOR)).toBeUndefined();
    // Renaming a shift type or recolouring it changes no demand.
    updateShiftType(handle.db, dayId, { name: 'Days', color: '#111111' }, ACTOR);
    expect(versions().length).toBe(before);
  });

  it('reads two rule lists in a different stored order as the same rules', () => {
    const second = createRatioRule(
      handle.db,
      { unitId, role: 'CNA', acuityTierId: null, maxPatientsPerNurse: 10, active: true },
      ACTOR,
    );
    const latest = latestDemandConfigVersion(handle.db, unitId)!;
    expect(latest.config.ratioRules.map((r) => r.id)).toEqual([ratioId, second.id].sort());
    expect(recordDemandConfigVersion(handle.db, unitId, ACTOR)).toBeUndefined();
  });

  it('records a week of floors filled at once as one version', () => {
    const before = versions().length;
    transact(handle.db, (tx) =>
      fillCoverageWeek(
        tx,
        { unitId, shiftTypeId: dayId, role: 'RN', minCount: 3, targetCount: 4 },
        ACTOR,
      ),
    );
    expect(versions().length).toBe(before + 1);
  });

  it('keeps only active ratio rules and active shift types in a version', () => {
    deactivateRatioRule(handle.db, ratioId, ACTOR, 'Replaced by the state ceiling');
    deactivateShiftType(handle.db, dayId, ACTOR);
    const { config } = latestDemandConfigVersion(handle.db, unitId)!;
    expect(config.ratioRules).toEqual([]);
    expect(config.activeShiftTypeIds).toEqual([]);
    // The floor stays: a retired type's floors are still rows, and judging skips the type.
    expect(config.coverageRequirements.map((c) => c.id)).toEqual([floorId]);
  });

  it('numbers versions one after another and audits each against its unit', () => {
    const seqs = versions()
      .map((v) => v.seq)
      .sort((a, b) => a - b);
    // Tier, ratio, shift type, floor: four writes that each changed the rules.
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(auditHistoryFor(handle.db, 'demand_config_version', unitId)).toHaveLength(4);
  });
});

describe('a step that writes many rows leaves one complete version', () => {
  it('records the whole 12-hour pattern as one version, never its first shift alone', () => {
    const fresh = newUnit('5 East');
    transact(handle.db, (tx) =>
      applySetupPreset(tx, fresh, { kind: 'shift-pattern', pattern: '12h' }, ACTOR),
    );
    expect(versions(fresh)).toHaveLength(1);
    // The 12-hour pattern is a day and a night shift.
    const { config } = latestDemandConfigVersion(handle.db, fresh)!;
    expect(config.activeShiftTypeIds).toHaveLength(2);
    expect(config).toEqual(currentDemandConfig(handle.db, fresh));
  });

  it('records a state preset and a duplicate as one version each', () => {
    let before = versions().length;
    transact(handle.db, (tx) => applyJurisdiction(tx, unitId, 'CA', ACTOR));
    expect(versions().length).toBe(before + 1);
    before = versions().length;
    transact(handle.db, (tx) =>
      duplicateShiftType(tx, dayId, { name: 'Day 12 (2027)', abbreviation: 'D12B' }, ACTOR),
    );
    expect(versions().length).toBe(before + 1);
    expect(latestDemandConfigVersion(handle.db, unitId)!.config).toEqual(
      currentDemandConfig(handle.db, unitId),
    );
  });

  it('joins a batch inside another and records once, when the outer one ends', () => {
    const before = versions().length;
    batchDemandVersions(handle.db, () => {
      createRatioRule(
        handle.db,
        { unitId, role: 'CNA', acuityTierId: null, maxPatientsPerNurse: 10, active: true },
        ACTOR,
      );
      batchDemandVersions(handle.db, () => {
        updateAcuityTier(handle.db, tierId, { careHoursPerPatientDay: 7 }, ACTOR);
      });
      expect(versions().length).toBe(before);
    });
    expect(versions().length).toBe(before + 1);
    expect(dirty()).toEqual([]);
  });

  it('records nothing for a batch that failed, and the next write records as usual', () => {
    const before = versions().length;
    expect(() =>
      batchDemandVersions(handle.db, () => {
        updateAcuityTier(handle.db, tierId, { careHoursPerPatientDay: 7 }, ACTOR);
        throw new Error('The manager cancelled');
      }),
    ).toThrow('The manager cancelled');
    expect(versions().length).toBe(before);
    updateAcuityTier(handle.db, tierId, { careHoursPerPatientDay: 8 }, ACTOR);
    expect(versions().length).toBe(before + 1);
  });

  const seededVersions = (seed: (tx: Parameters<Parameters<typeof transact>[1]>[0]) => void) => {
    const seeded = openTestDatabase();
    try {
      transact(seeded.db, seed);
      expect(seeded.db.select().from(demandConfigDirty).all()).toEqual([]);
      return seeded.db
        .select()
        .from(unitTable)
        .all()
        .map(({ id }) => ({
          count: seeded.db
            .select()
            .from(demandConfigVersion)
            .where(eq(demandConfigVersion.unitId, id))
            .all().length,
          complete:
            JSON.stringify(latestDemandConfigVersion(seeded.db, id)!.config) ===
            JSON.stringify(currentDemandConfig(seeded.db, id)),
        }));
    } finally {
      seeded.close();
    }
  };

  it('gives the test scenarios one version holding their whole configuration', () => {
    const units = seededVersions((tx) => {
      seedScenarioUnit(tx, { seed: 42, today: isoDate('2026-09-17'), historyPeriods: 1 });
    });
    expect(units).toEqual([{ count: 1, complete: true }]);
  });

  it('gives a demo unit and its float sibling one complete version each', () => {
    const units = seededVersions((tx) => {
      seedDemoUnit(tx, { demo: 'va-sf-med-surg', today: isoDate('2026-09-17'), historyPeriods: 1 });
    });
    expect(units).toEqual([
      { count: 1, complete: true },
      { count: 1, complete: true },
    ]);
  });
});

describe('the demand history cannot be rewritten', () => {
  it('refuses to edit or delete a recorded version', () => {
    expect(() => run("UPDATE demand_config_version SET reason = 'x'")).toThrow(/cannot be changed/);
    expect(() => run('DELETE FROM demand_config_version')).toThrow(/cannot be deleted/);
  });

  it('refuses to delete a unit that has demand history', () => {
    expect(() => run('DELETE FROM unit')).toThrow(/cannot be deleted/);
  });
});

describe('a change saved without its version is caught', () => {
  it('marks the unit when the file is edited behind the repositories', () => {
    run('UPDATE ratio_rule SET max_patients_per_nurse = 6 WHERE id = ?', ratioId);
    expect(dirty()).toEqual([unitId]);
  });

  it('does not mark the unit for a write that changes no demand column', () => {
    run('UPDATE ratio_rule SET max_patients_per_nurse = max_patients_per_nurse');
    run("UPDATE shift_type SET name = 'Days', active = active");
    run("UPDATE unit SET name = '4 West Annex', break_minutes_per_nurse = 0");
    expect(dirty()).toEqual([]);
  });

  it('marks the unit for a retired or deleted shift type, an inserted floor and staffing', () => {
    run('UPDATE shift_type SET active = 0');
    expect(dirty()).toEqual([unitId]);
    recordDemandConfigVersion(handle.db, unitId, ACTOR);
    expect(dirty()).toEqual([]);
    run(
      "INSERT INTO coverage_requirement (id, unit_id, shift_type_id, weekday, role, min_count, target_count) VALUES ('cov_x', ?, ?, 3, 'RN', 4, 4)",
      unitId,
      dayId,
    );
    expect(dirty()).toEqual([unitId]);
    recordDemandConfigVersion(handle.db, unitId, ACTOR);
    run('UPDATE unit SET charge_covers_breaks = 1 WHERE id = ?', unitId);
    expect(dirty()).toEqual([unitId]);
    recordDemandConfigVersion(handle.db, unitId, ACTOR);
    run('DELETE FROM coverage_requirement');
    recordDemandConfigVersion(handle.db, unitId, ACTOR);
    run('DELETE FROM shift_type WHERE id = ?', dayId);
    expect(dirty()).toEqual([unitId]);
  });

  it('records the missed version at startup with a reason saying so', () => {
    run('UPDATE ratio_rule SET max_patients_per_nurse = 6 WHERE id = ?', ratioId);
    const recorded = transact(handle.db, (tx) => backfillDemandConfigVersions(tx, ACTOR));
    expect(recorded).toBe(1);
    expect(dirty()).toEqual([]);
    const latest = latestDemandConfigVersion(handle.db, unitId)!;
    expect(latest.reason).toBe('Recorded at startup: a change was saved without its version.');
    expect(latest.config.ratioRules[0]!.maxPatientsPerNurse).toBe(6);
  });

  it('gives a unit that has no version yet its first one, once', () => {
    const quiet = newUnit('5 East');
    expect(versions(quiet)).toEqual([]);
    expect(transact(handle.db, (tx) => backfillDemandConfigVersions(tx, ACTOR))).toBe(1);
    const first = latestDemandConfigVersion(handle.db, quiet)!;
    expect(first.seq).toBe(1);
    expect(first.config).toEqual({
      activeShiftTypeIds: [],
      acuityTiers: [],
      ratioRules: [],
      coverageRequirements: [],
      ratioStaffing: {
        chargeNurseTakesPatients: true,
        breakMinutesPerNurse: 0,
        chargeCoversBreaks: false,
      },
    });
    expect(transact(handle.db, (tx) => backfillDemandConfigVersions(tx, ACTOR))).toBe(0);
  });

  it('forgets a mark left by a unit that no longer exists', () => {
    run("INSERT INTO demand_config_dirty (unit_id) VALUES ('unit_gone')");
    expect(transact(handle.db, (tx) => backfillDemandConfigVersions(tx, ACTOR))).toBe(0);
    expect(dirty()).toEqual([]);
  });
});

describe('the rules in force on a date', () => {
  it('reads the version in force at the end of the day, and the earliest before any', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(localInstant(isoDate('2026-03-01'), '06:00'));
    const unit = newUnit('3 North');
    createRatioRule(
      handle.db,
      { unitId: unit, role: 'RN', acuityTierId: null, maxPatientsPerNurse: 5, active: true },
      ACTOR,
    );
    const ratio = latestDemandConfigVersion(handle.db, unit)!.config.ratioRules[0]!.id;
    vi.setSystemTime(localInstant(isoDate('2026-03-08'), '10:00'));
    updateRatioRule(
      handle.db,
      ratio,
      { maxPatientsPerNurse: 6 },
      ACTOR,
      'The state lifted the emergency ceiling',
    );

    const ceilingOn = (date: string) =>
      demandConfigOn(handle.db, unit, isoDate(date))!.config.ratioRules[0]!.maxPatientsPerNurse;
    expect(ceilingOn('2026-03-07')).toBe(5);
    // Changed at 10:00 on the 8th, so in force when the 8th ended.
    expect(ceilingOn('2026-03-08')).toBe(6);
    expect(ceilingOn('2026-03-09')).toBe(6);
    // Before the first version: the earliest one, not today's rules.
    expect(ceilingOn('2026-02-20')).toBe(5);
    expect(demandConfigOn(handle.db, newUnit('Empty'), isoDate('2026-03-08'))).toBeUndefined();
  });

  it('keeps the reason a loosened ratio was given on its version', () => {
    updateRatioRule(handle.db, ratioId, { maxPatientsPerNurse: 6 }, ACTOR, 'New contract');
    expect(latestDemandConfigVersion(handle.db, unitId)!.reason).toBe('New contract');
  });

  it('refuses a version dated before the one recorded last', () => {
    run('UPDATE ratio_rule SET max_patients_per_nurse = 6 WHERE id = ?', ratioId);
    expect(() =>
      recordDemandConfigVersion(handle.db, unitId, ACTOR, {
        at: localInstant(isoDate('2020-01-01'), '00:00'),
      }),
    ).toThrow(/before/);
  });

  it('reads the live rules as they stand now', () => {
    expect(currentDemandConfig(handle.db, unitId)).toEqual(
      latestDemandConfigVersion(handle.db, unitId)!.config,
    );
  });
});

describe('a published schedule is judged by the demand rules of each date', () => {
  const at = (date: string, time: string) => localInstant(isoDate(date), time);

  /**
   * A med-surg unit as it stood before March: one tier, RN 1:5 on every tier, the charge nurse
   * taking patients and no break relief, a census of 30 on the day shift every day, and
   * 1–14 March published. Set up at `setupAt`, in one batch, so its first version is whole.
   */
  function marchUnit(setupAt: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(setupAt);
    const db = handle.db;
    const built = transact(db, (tx) =>
      batchDemandVersions(tx, () => {
        const unit = newUnit('3 North');
        const tier = createAcuityTier(
          tx,
          { unitId: unit, name: 'Med-surg', level: 1, careHoursPerPatientDay: 6 },
          ACTOR,
        );
        const ratio = createRatioRule(
          tx,
          { unitId: unit, role: 'RN', acuityTierId: null, maxPatientsPerNurse: 5, active: true },
          ACTOR,
        );
        const day = createShiftType(
          tx,
          {
            unitId: unit,
            name: 'Day 12',
            abbreviation: 'D12',
            startTime: '07:00',
            durationHours: 12,
            isNight: false,
            isOnCall: false,
            color: '#0ea5e9',
            sortOrder: 1,
            active: true,
          },
          ACTOR,
        );
        upsertCensusForecasts(
          tx,
          datesInRange(isoDate('2026-03-01'), isoDate('2026-03-14')).map((date) => ({
            unitId: unit,
            date,
            shiftTypeId: day.id,
            projectedCensus: 30,
            acuityMix: { [tier.id]: 30 },
            source: 'manual' as const,
          })),
          ACTOR,
        );
        return { unit, ratio: ratio.id, day: day.id };
      }),
    );
    const ruleSet = transact(db, (tx) =>
      saveRuleSet(
        tx,
        {
          unitId: built.unit,
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
    const draft = createPeriod(
      db,
      {
        unitId: built.unit,
        name: 'March 1–14',
        startDate: isoDate('2026-03-01'),
        endDate: isoDate('2026-03-14'),
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      },
      ACTOR,
    );
    transact(db, (tx) => publishSchedule(tx, { periodId: draft.id, ledger: [] }, ACTOR));
    return { ...built, period: getPeriod(db, draft.id)!, draft };
  }

  /** Each date's RN `ratioDerived` on one shift type, or `-` where it has no demand row. */
  const rnByDate = (input: SolveInput, shiftTypeId: Id) =>
    datesInRange(input.period.startDate, input.period.endDate).map((date) => {
      const row = input.demand.find((d) => d.date === date && d.shiftTypeId === shiftTypeId);
      return row ? row.byRole.RN.ratioDerived : '-';
    });

  function loosenOnThe8th(ratio: Id) {
    vi.setSystemTime(at('2026-03-08', '10:00'));
    updateRatioRule(
      handle.db,
      ratio,
      { maxPatientsPerNurse: 6 },
      ACTOR,
      'The state lifted the emergency ceiling',
    );
  }

  it('keeps the 1:5 shortfall on the days before the ratio was loosened', () => {
    const march = marchUnit(at('2026-02-20', '09:00'));
    loosenOnThe8th(march.ratio);
    const input = loadPeriodInput(handle.db, march.period, { today: isoDate('2026-03-12') });
    // 1–7 March under 1:5: 30 / 5 = 6. The 8th ended under 1:6: ceil(30 / 6) = 5. The 9th–11th
    // under 1:6: 5. The 12th onward is not past, so live: 1:6, 5.
    expect(rnByDate(input, march.day)).toEqual([6, 6, 6, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 5]);
  });

  it('judges every date by the live rules when no today is given, or for a draft', () => {
    const march = marchUnit(at('2026-02-20', '09:00'));
    loosenOnThe8th(march.ratio);
    const live = Array(14).fill(5);
    expect(rnByDate(loadPeriodInput(handle.db, march.period), march.day)).toEqual(live);
    const asDraft = { ...march.period, status: 'draft' as const };
    expect(
      rnByDate(loadPeriodInput(handle.db, asDraft, { today: isoDate('2026-03-12') }), march.day),
    ).toEqual(live);
  });

  it('gives the inputs one past date was judged by', () => {
    const march = marchUnit(at('2026-02-20', '09:00'));
    loosenOnThe8th(march.ratio);
    const live = demandInputs(handle.db, march.unit, isoDate('2026-03-01'), isoDate('2026-03-14'));
    const ceilingOn = (date: string) =>
      demandInputsForDate(handle.db, march.period, isoDate(date), {
        today: isoDate('2026-03-12'),
        live,
      }).ratioRules[0]!.maxPatientsPerNurse;
    expect(ceilingOn('2026-03-07')).toBe(5);
    expect(ceilingOn('2026-03-08')).toBe(6);
    expect(ceilingOn('2026-03-12')).toBe(6);
  });

  it('moves the demand to a duplicated shift type only from the day it was duplicated', () => {
    const march = marchUnit(at('2026-02-20', '09:00'));
    vi.setSystemTime(at('2026-03-08', '10:00'));
    const copy = transact(handle.db, (tx) =>
      duplicateShiftType(
        tx,
        march.day,
        { name: 'Day 12 (new times)', abbreviation: 'D12N' },
        ACTOR,
      ),
    ).shiftType.id;
    const input = loadPeriodInput(handle.db, march.period, { today: isoDate('2026-03-12') });
    const dash = Array(7).fill('-');
    // The forecasts dated inside the published period stay on the old type, so the copy's rows
    // carry no census: its RN need from ratio is 0.
    expect(rnByDate(input, march.day)).toEqual([...Array(7).fill(6), ...dash]);
    expect(rnByDate(input, copy)).toEqual([...dash, ...Array(7).fill(0)]);
    // The types themselves keep their live flags: the old one is retired.
    expect(input.shiftTypes.find((t) => t.id === march.day)!.active).toBe(false);
  });

  it('judges history older than the first version by the earliest version, not live', () => {
    // Versions began on 1 April; the March schedule was seeded before then.
    const march = marchUnit(at('2026-04-01', '09:00'));
    vi.setSystemTime(at('2026-04-02', '09:00'));
    updateRatioRule(handle.db, march.ratio, { maxPatientsPerNurse: 6 }, ACTOR, 'New contract');
    const input = loadPeriodInput(handle.db, march.period, { today: isoDate('2026-04-10') });
    // The earliest version's 1:5: 30 / 5 = 6 on every date (live 1:6 would read 5).
    expect(rnByDate(input, march.day)).toEqual(Array(14).fill(6));
  });

  it('still judges a schedule whose unit has a change saved without its version, and says so once', () => {
    const march = marchUnit(at('2026-02-20', '09:00'));
    loosenOnThe8th(march.ratio);
    // Edited behind the repositories: the 1:7 is live but no version holds it.
    run('UPDATE ratio_rule SET max_patients_per_nurse = 7 WHERE id = ?', march.ratio);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const judge = () =>
        rnByDate(
          loadPeriodInput(handle.db, march.period, { today: isoDate('2026-03-12') }),
          march.day,
        );
      // The versions it has: 30 / 5 = 6 through the 7th, ceil(30 / 6) = 5 for the 8th–11th; the
      // 12th onward is live 1:7, ceil(30 / 7) = 5.
      const expected = [6, 6, 6, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 5];
      expect(judge()).toEqual(expected);
      expect(judge()).toEqual(expected);
      const live = demandInputs(
        handle.db,
        march.unit,
        march.period.startDate,
        march.period.endDate,
      );
      demandInputsForDate(handle.db, march.period, isoDate('2026-03-07'), {
        today: isoDate('2026-03-12'),
        live,
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toContain(march.unit);
    } finally {
      logged.mockRestore();
    }
  });

  it('judges a unit with no version at all by the live rules', () => {
    const march = marchUnit(at('2026-02-20', '09:00'));
    loosenOnThe8th(march.ratio);
    // Versions cannot be removed, so the same period read as if it belonged to a unit that never
    // recorded one (a file from before versions were kept, not yet started up).
    const period = { ...march.period, unitId: newUnit('Bare') };
    const live = demandInputs(handle.db, march.unit, isoDate('2026-03-01'), isoDate('2026-03-14'));
    const table = demandTableFor(handle.db, period, { today: isoDate('2026-03-12'), live });
    // Live 1:6 on every date: ceil(30 / 6) = 5, the 1st–7th included.
    expect(
      datesInRange(isoDate('2026-03-01'), isoDate('2026-03-14')).map(
        (date) => table.get(date, march.day)!.byRole.RN.ratioDerived,
      ),
    ).toEqual(Array(14).fill(5));
  });
});
