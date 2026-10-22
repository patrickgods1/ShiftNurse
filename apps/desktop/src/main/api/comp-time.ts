/**
 * Banking a finished schedule's overtime as comp time, for the nurses who elected it.
 *
 * 29 U.S.C. § 207(o) lets a public employer give 1.5 hours of comp time for each overtime hour
 * instead of cash, by an agreement made before the work, up to a cap (240 hours for most work);
 * overtime past the cap is still paid. The period is banked once it is published and over, when
 * its overtime can no longer move: banking a draft, or a week still being worked, would credit
 * hours that a later edit takes away, and credits are final.
 *
 * Everything is read from what the schedule was published under: the overtime is the cost
 * report's (the period's pay snapshot), the rate and cap are that snapshot's, and a nurse's
 * balance is the same projection a comp request is checked against (`projectedLeaveBalance`), so
 * the cap is applied to the figure the manager will later see. All of it is read and written in
 * one transaction, so two runs cannot both bank (the unique index on nurse and period backs it).
 */

import { addDays, compareDates, compTimeCredit, type Id, type IsoDate } from '@shiftnurse/core';
import {
  latestPayConfigSnapshot,
  listCompTimeElectionsForUnit,
  recordCompTimeCredits,
  type ShiftNurseDb,
  transact,
} from '@shiftnurse/db';
import type { CompTimeCreditRecord } from '../../shared/api.js';
import { ACTOR, periodOrThrow } from './context.js';
import { costReport, electedOvertimeMinutes } from './cost.js';
import { projectedLeaveBalance } from './leave-balances.js';

export function bankCompTime(
  db: ShiftNurseDb,
  periodId: Id,
  today: IsoDate,
): CompTimeCreditRecord[] {
  return transact(db, (tx) => {
    const period = periodOrThrow(tx, periodId);
    if (period.status === 'draft' || compareDates(period.endDate, today) >= 0) {
      throw new Error(
        'Comp time is banked once the schedule is published and its last day has passed.',
      );
    }
    const setting = latestPayConfigSnapshot(tx, period.id)?.config.paySettings.compTime ?? null;
    if (setting === null) {
      throw new Error('Comp time was off in the pay settings this schedule was published under.');
    }

    const report = costReport(tx, period.id, today);
    const overtimeMinutes = electedOvertimeMinutes(tx, period, report.cost.assignments);
    const unitElections = listCompTimeElectionsForUnit(tx, period.unitId);

    const rows = [...overtimeMinutes]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([nurseId, minutes]) => {
        // A nurse payroll never gave a comp figure starts at 0 from before her first election on
        // this unit: she could not have earned comp time here before she agreed to take it. Listed
        // by start date, and she has one, or she would have no elected overtime.
        const first = unitElections.find((e) => e.nurseId === nurseId)!;
        const projected = projectedLeaveBalance(tx, nurseId, 'comp', period.endDate, {
          balanceHours: 0,
          asOf: addDays(first.startsOn, -1),
        });
        const overtimeHours = minutes / 60;
        const credit = compTimeCredit({
          overtimeHours,
          hoursPerOvertimeHour: setting.hoursPerOvertimeHour,
          capHours: setting.capHours,
          projectedBalanceHours: projected!.hours,
        });
        return { nurseId, overtimeHours, ...credit };
      });
    return recordCompTimeCredits(tx, period.id, rows, ACTOR);
  });
}
