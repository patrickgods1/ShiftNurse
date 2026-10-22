/**
 * The census resource: forecasts and actuals, the forecaster's proposals and back-test, and the
 * demand and HPPD derived from them. Writes run in one transaction with their audit row.
 */

import {
  backtest,
  dateInRange,
  datesInRange,
  type Id,
  type IsoDate,
  proposeCensus,
  type ShiftDemand,
  scheduledHppd,
  today,
} from '@shiftnurse/core';
import {
  type DbLike,
  deleteCensusForecast,
  demandInputs,
  demandTableFor,
  listAssignmentsForPeriod,
  listCensusForecastsInRange,
  listCensusHistory,
  listPeriodsForUnit,
  listShiftTypesForUnit,
  recordActualCensus,
  type ShiftNurseDb,
  transact,
  upsertCensusForecast,
  upsertCensusForecasts,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR, periodOrThrow } from './context.js';

/**
 * The Demand page's range, each date judged as the schedule holding it is: a date only a draft
 * covers is a proposal under today's rules, and any other past date (a published schedule's, or
 * one no schedule covers) reads the rules in force that day. Read live, loosening a ratio would
 * redraw last month's demand on this page while the grid still judged it under the old one.
 */
function demandForRange(db: DbLike, unitId: Id, start: IsoDate, end: IsoDate): ShiftDemand[] {
  const live = demandInputs(db, unitId, start, end);
  const now = today();
  const periods = listPeriodsForUnit(db, unitId);
  const draftOnly = (date: IsoDate) => {
    const covering = periods.filter((p) => dateInRange(date, p.startDate, p.endDate));
    return covering.length > 0 && covering.every((p) => p.status === 'draft');
  };
  const runs: { draft: boolean; startDate: IsoDate; endDate: IsoDate }[] = [];
  for (const date of datesInRange(start, end)) {
    const draft = draftOnly(date);
    const last = runs[runs.length - 1];
    if (last && last.draft === draft) last.endDate = date;
    else runs.push({ draft, startDate: date, endDate: date });
  }
  return runs.flatMap(({ draft, startDate, endDate }) =>
    demandTableFor(
      db,
      { unitId, status: draft ? 'draft' : 'published', startDate, endDate },
      { today: now, live },
    ).all(),
  );
}

export function censusApi(db: ShiftNurseDb): ShiftNurseApi['census'] {
  return {
    list: (unitId, start, end) => listCensusForecastsInRange(db, unitId, start, end),
    upsert: (input) => transact(db, (tx) => upsertCensusForecast(tx, input, ACTOR)),
    upsertMany: (inputs) => transact(db, (tx) => upsertCensusForecasts(tx, inputs, ACTOR)),
    recordActual: (id, actualCensus, actualAcuityMix) =>
      transact(db, (tx) => recordActualCensus(tx, id, actualCensus, actualAcuityMix, ACTOR)),
    delete: (id) => transact(db, (tx) => deleteCensusForecast(tx, id, ACTOR)),
    propose: (unitId, start, end, options) => {
      const shiftTypes = listShiftTypesForUnit(db, unitId).filter((s) => s.active && !s.isOnCall);
      const targets = datesInRange(start, end).flatMap((date) =>
        shiftTypes.map((s) => ({ date, shiftTypeId: s.id })),
      );
      return proposeCensus(listCensusHistory(db, unitId), targets, options);
    },
    backtest: (unitId, options) => backtest(listCensusHistory(db, unitId), options),
    demand: (unitId, start, end) => demandForRange(db, unitId, start, end),
    hppd: (periodId) => {
      const period = periodOrThrow(db, periodId);
      const dates = datesInRange(period.startDate, period.endDate);
      const inputs = demandInputs(db, period.unitId, period.startDate, period.endDate);
      return scheduledHppd({
        dates,
        shiftTypes: inputs.shiftTypes,
        // As the grid judges the period: a past date under the rules in force that day.
        demand: demandTableFor(db, period, { today: today(), live: inputs }),
        assignments: listAssignmentsForPeriod(db, periodId),
        target: inputs.hppdTarget,
      });
    },
  };
}
