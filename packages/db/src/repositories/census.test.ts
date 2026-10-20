import { isoDate } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { auditLog } from '../schema.js';
import { createAcuityTier } from './acuity.js';
import {
  deleteCensusForecast,
  listCensusForecastsInRange,
  recordActualCensus,
  upsertCensusForecast,
} from './census.js';
import { createShiftType, createUnit } from './config.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let shiftTypeId: string;
let tierId: string;

beforeEach(() => {
  handle = openTestDatabase();
  unitId = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  shiftTypeId = createShiftType(
    handle.db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#000',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  tierId = createAcuityTier(
    handle.db,
    { unitId, name: 'Routine', level: 1, careHoursPerPatientDay: 4 },
    ACTOR,
  ).id;
});
afterEach(() => handle.close());

describe('census forecasts', () => {
  it('entering the same date and shift twice updates the one cell rather than adding a row', () => {
    const base = { unitId, date: isoDate('2026-09-08'), shiftTypeId, source: 'manual' as const };
    const first = upsertCensusForecast(
      handle.db,
      { ...base, projectedCensus: 20, acuityMix: { [tierId]: 20 } },
      ACTOR,
    );
    const second = upsertCensusForecast(
      handle.db,
      { ...base, projectedCensus: 24, acuityMix: { [tierId]: 24 } },
      ACTOR,
    );
    expect(second.id).toBe(first.id);
    const rows = listCensusForecastsInRange(
      handle.db,
      unitId,
      isoDate('2026-09-01'),
      isoDate('2026-09-30'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectedCensus).toBe(24);
    expect(auditHistoryFor(handle.db, 'census_forecast', first.id).map((a) => a.action)).toEqual([
      'update',
      'create',
    ]);
  });

  it('refuses a mix that does not add up to the census', () => {
    expect(() =>
      upsertCensusForecast(
        handle.db,
        {
          unitId,
          date: isoDate('2026-09-08'),
          shiftTypeId,
          projectedCensus: 20,
          acuityMix: { [tierId]: 19 },
          source: 'manual',
        },
        ACTOR,
      ),
    ).toThrow(/19 patients but the census is 20/);
  });

  it('records the actual census alongside the forecast for later back-testing', () => {
    const row = upsertCensusForecast(
      handle.db,
      {
        unitId,
        date: isoDate('2026-09-08'),
        shiftTypeId,
        projectedCensus: 20,
        acuityMix: { [tierId]: 20 },
        source: 'forecast',
      },
      ACTOR,
    );
    const updated = recordActualCensus(handle.db, row.id, 23, { [tierId]: 23 }, ACTOR);
    expect(updated.projectedCensus).toBe(20);
    expect(updated.actualCensus).toBe(23);
    expect(updated.source).toBe('forecast');
  });

  it('saves a census on a unit with no acuity tiers', () => {
    const tierless = createUnit(
      handle.db,
      {
        name: 'Short Stay',
        unitType: 'Medical-Surgical',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    ).id;
    const day = createShiftType(
      handle.db,
      {
        unitId: tierless,
        name: 'Day 12',
        abbreviation: 'D12',
        startTime: '07:00',
        durationHours: 12,
        isNight: false,
        isOnCall: false,
        color: '#000',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    ).id;
    const row = upsertCensusForecast(
      handle.db,
      {
        unitId: tierless,
        date: isoDate('2026-09-08'),
        shiftTypeId: day,
        projectedCensus: 20,
        acuityMix: {},
        source: 'manual',
      },
      ACTOR,
    );
    expect(row.projectedCensus).toBe(20);
    expect(recordActualCensus(handle.db, row.id, 18, {}, ACTOR).actualCensus).toBe(18);
  });

  it('still refuses an empty mix for a full census on a unit that has tiers', () => {
    expect(() =>
      upsertCensusForecast(
        handle.db,
        {
          unitId,
          date: isoDate('2026-09-08'),
          shiftTypeId,
          projectedCensus: 20,
          acuityMix: {},
          source: 'manual',
        },
        ACTOR,
      ),
    ).toThrow(/0 patients but the census is 20/);
  });

  it('names the tier when a saved count is fractional', () => {
    const high = createAcuityTier(
      handle.db,
      { unitId, name: 'High', level: 3, careHoursPerPatientDay: 9 },
      ACTOR,
    ).id;
    const save = () =>
      upsertCensusForecast(
        handle.db,
        {
          unitId,
          date: isoDate('2026-09-08'),
          shiftTypeId,
          projectedCensus: 3,
          acuityMix: { [tierId]: 1.5, [high]: 1.5 },
          source: 'manual',
        },
        ACTOR,
      );
    expect(save).toThrow('Routine: 1.5 must be a whole number of patients, 0 or more');
    expect(save).not.toThrow(tierId);
  });

  it('names the tier when a recorded actual count is fractional', () => {
    const row = upsertCensusForecast(
      handle.db,
      {
        unitId,
        date: isoDate('2026-09-08'),
        shiftTypeId,
        projectedCensus: 20,
        acuityMix: { [tierId]: 20 },
        source: 'manual',
      },
      ACTOR,
    );
    expect(() => recordActualCensus(handle.db, row.id, 2, { [tierId]: 2.5 }, ACTOR)).toThrow(
      'Routine: 2.5 must be a whole number of patients, 0 or more',
    );
  });

  describe('what a census may name', () => {
    const MIX_REFUSAL = 'An acuity tier in this mix is no longer on the unit.';
    const forecast = (over: Partial<Parameters<typeof upsertCensusForecast>[1]> = {}) => ({
      unitId,
      date: isoDate('2026-09-08'),
      shiftTypeId,
      projectedCensus: 20,
      acuityMix: { [tierId]: 20 },
      source: 'manual' as const,
      ...over,
    });
    const censusAudits = () =>
      handle.db.select().from(auditLog).where(eq(auditLog.entityType, 'census_forecast')).all();
    const expectNothingStored = () => {
      expect(
        listCensusForecastsInRange(handle.db, unitId, isoDate('2026-09-01'), isoDate('2026-09-30')),
      ).toEqual([]);
      expect(censusAudits()).toEqual([]);
    };
    const east = () => {
      const eastId = createUnit(
        handle.db,
        {
          name: '5 East',
          unitType: 'Medical-Surgical',
          payPeriodDays: 14,
          payPeriodAnchor: isoDate('2026-01-04'),
        },
        ACTOR,
      ).id;
      const eastHigh = createAcuityTier(
        handle.db,
        { unitId: eastId, name: 'High', level: 2, careHoursPerPatientDay: 8 },
        ACTOR,
      ).id;
      const eastNight = createShiftType(
        handle.db,
        {
          unitId: eastId,
          name: 'Night 12',
          abbreviation: 'N12',
          startTime: '19:00',
          durationHours: 12,
          isNight: true,
          isOnCall: false,
          color: '#000',
          sortOrder: 2,
          active: true,
        },
        ACTOR,
      ).id;
      return { eastHigh, eastNight };
    };

    it('refuses a patient mix that names another unit’s tier', () => {
      const { eastHigh } = east();
      expect(() =>
        upsertCensusForecast(handle.db, forecast({ acuityMix: { [eastHigh]: 20 } }), ACTOR),
      ).toThrow(MIX_REFUSAL);
      expectNothingStored();
    });

    it('refuses a mix with a tier that does not exist', () => {
      expect(() =>
        upsertCensusForecast(handle.db, forecast({ acuityMix: { tier_gone: 20 } }), ACTOR),
      ).toThrow(MIX_REFUSAL);
      expectNothingStored();
    });

    it('refuses a forecast for another unit’s shift', () => {
      const { eastNight } = east();
      expect(() =>
        upsertCensusForecast(handle.db, forecast({ shiftTypeId: eastNight }), ACTOR),
      ).toThrow('Night 12 is a shift on 5 East, not on 4 West.');
      expect(() =>
        upsertCensusForecast(handle.db, forecast({ shiftTypeId: 'gone' }), ACTOR),
      ).toThrow('That shift type was not found. Reload the page.');
      expectNothingStored();
    });

    it('refuses an actual census that names another unit’s tier', () => {
      const { eastHigh } = east();
      const row = upsertCensusForecast(handle.db, forecast(), ACTOR);
      expect(() => recordActualCensus(handle.db, row.id, 18, { [eastHigh]: 18 }, ACTOR)).toThrow(
        MIX_REFUSAL,
      );
      const [after] = listCensusForecastsInRange(
        handle.db,
        unitId,
        isoDate('2026-09-01'),
        isoDate('2026-09-30'),
      );
      expect(after?.actualCensus).toBeUndefined();
      expect(after?.actualAcuityMix).toBeUndefined();
    });

    it('says so when recording an actual for a census day that is gone', () => {
      expect(() => recordActualCensus(handle.db, 'gone', 18, {}, ACTOR)).toThrow(
        'That census day was not found. Reload the page.',
      );
    });

    it('says so when deleting a census day that is already gone', () => {
      expect(() => deleteCensusForecast(handle.db, 'gone', ACTOR)).toThrow(
        'That census day was not found. Reload the page.',
      );
    });

    it('deletes a census day and keeps what it was on the record', () => {
      const row = upsertCensusForecast(handle.db, forecast(), ACTOR);
      deleteCensusForecast(handle.db, row.id, ACTOR);
      expect(
        listCensusForecastsInRange(handle.db, unitId, isoDate('2026-09-01'), isoDate('2026-09-30')),
      ).toEqual([]);
      expect(auditHistoryFor(handle.db, 'census_forecast', row.id)[0]).toMatchObject({
        action: 'delete',
        before: { projectedCensus: 20 },
      });
    });
  });
});
