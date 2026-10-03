/**
 * The census resource: forecasts and actuals, the forecaster's proposals and back-test, and the
 * demand and HPPD derived from them. Writes run in one transaction with their audit row.
 */

import {
  backtest,
  datesInRange,
  deriveDemand,
  proposeCensus,
  scheduledHppd,
} from '@shiftnurse/core';
import {
  deleteCensusForecast,
  demandInputs,
  listAssignmentsForPeriod,
  listCensusForecastsInRange,
  listCensusHistory,
  listShiftTypesForUnit,
  recordActualCensus,
  type ShiftNurseDb,
  transact,
  upsertCensusForecast,
  upsertCensusForecasts,
} from '@shiftnurse/db';
import type { ShiftNurseApi } from '../../shared/api.js';
import { ACTOR, periodOrThrow } from './context.js';

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
    demand: (unitId, start, end) =>
      deriveDemand(datesInRange(start, end), demandInputs(db, unitId, start, end)).all(),
    hppd: (periodId) => {
      const period = periodOrThrow(db, periodId);
      const dates = datesInRange(period.startDate, period.endDate);
      const inputs = demandInputs(db, period.unitId, period.startDate, period.endDate);
      return scheduledHppd({
        dates,
        shiftTypes: inputs.shiftTypes,
        demand: deriveDemand(dates, inputs),
        assignments: listAssignmentsForPeriod(db, periodId),
        target: inputs.hppdTarget,
      });
    },
  };
}
