/**
 * The ledger a publish books is defined once, so the app, the history importer and the seeded
 * demos record the same burden for the same schedule.
 *
 * Without it the publish handler, the history importer and each seed turned a counting view into
 * ledger rows by hand, and a seed that skipped `deriveCounters` booked a weekend, an overtime hour
 * or a zero row that the app itself never would. The caller still builds its own view (the float
 * semantics of that view live in main), so this module takes the view rather than loading it.
 */

import {
  type CounterContext,
  deriveCounters,
  type Id,
  type IsoDate,
  type SchedulePeriod,
  type ScheduleView,
  type WeekendDefinition,
} from '@shiftnurse/core';
import type { DbLike } from '../client.js';
import { getUnit, listHolidaysForUnit } from './config.js';
import type { UpsertFairnessLedgerInput } from './ledger.js';
import { unitForPeriod } from './period-unit.js';
import { listPreferencesForUnit } from './roster.js';
import { timeOffForPeriod } from './solve-input.js';
import { listTimeOffForUnit } from './timeoff.js';

/** Everything `deriveCounters` needs for a unit, loaded once. A period narrows the time off read. */
export function counterContextFor(
  db: DbLike,
  unitId: Id,
  weekendDefinition: WeekendDefinition,
  // The period being counted; history import counts many periods, so it passes none and reads all.
  period?: SchedulePeriod,
): CounterContext {
  // A republish re-derives counters under the holiday attribution the period went out under.
  const unit = period ? unitForPeriod(db, period) : getUnit(db, unitId);
  if (!unit) throw new Error(`Unit ${unitId} not found`);
  const holidays = listHolidaysForUnit(db, unitId);
  return {
    unit,
    holidayDates: new Set<IsoDate>(holidays.map((h) => h.date)),
    holidayDateById: new Map(holidays.map((h) => [h.id, h.date])),
    weekendDefinition,
    preferences: listPreferencesForUnit(db, unitId),
    timeOff: period ? timeOffForPeriod(db, unit, period) : listTimeOffForUnit(db, unitId),
  };
}

/**
 * The ledger rows a publish books for the period `schedule` counts: core's counters, one row per
 * nurse with a shift in it. A nurse who worked nothing gets no row (absence, not zero burden):
 * a zero row would read as "worked no nights" rather than "no record".
 */
export function periodLedgerRows(
  schedule: ScheduleView,
  ctx: CounterContext,
): UpsertFairnessLedgerInput[] {
  // `assignments()` is in-period only, so lookback shifts never make a nurse "present".
  const present = new Set(schedule.assignments().map((v) => v.nurse.id));
  const rows: UpsertFairnessLedgerInput[] = [];
  for (const [nurseId, counters] of deriveCounters(schedule, ctx)) {
    if (!present.has(nurseId)) continue;
    rows.push({
      nurseId,
      periodId: schedule.period.id,
      periodStart: schedule.period.startDate,
      ...counters,
    });
  }
  return rows;
}
