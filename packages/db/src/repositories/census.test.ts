import { isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { listCensusForecastsInRange, recordActualCensus, upsertCensusForecast } from './census.js';
import { createAcuityTier, createShiftType, createUnit } from './config.js';

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
});
