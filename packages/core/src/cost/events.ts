/**
 * Pay for what happens on the day rather than on the schedule: a meal or rest break missed, a
 * nurse sent home on arrival, a nurse on standby called back in.
 *
 * None of these is an assignment, so the schedule's cost (`costSchedule`) never sees them, and a
 * unit that sends staff home or works through breaks every week pays far more than its cost
 * report says. Priced here from events the day-of console records, and shown beside the schedule's
 * cost, never folded into it (so a schedule's price is still the same before and after the day).
 *
 * - **Missed break** (Cal. Labor Code § 226.7): one hour's pay for each workday a meal period is
 *   missed, and one for each a rest period is — at most one of each a day, however many are
 *   missed.
 * - **Sent home on arrival** (IWC Wage Order 5 § 5, reporting-time pay): half the scheduled
 *   shift, never under 2 hours nor over 4 — and never less than the hours actually worked.
 * - **Call-back**: the hours worked, or the contract's minimum if more, at the call-back
 *   differential (a multiplier on base, or dollars added to it); base pay with none configured.
 *
 * The rate is the nurse's base rate. California measures the break premium at the "regular
 * rate", which includes non-discretionary pay such as differentials (Ferra v. Loews Hollywood
 * Hotel, 2021); a unit paying large differentials will see this undercount, and README › What
 * ShiftNurse does not enforce yet says so. A nurse with no rate is counted as unpriced, never $0.
 */

import type { Id, Nurse } from '../domain/entities.js';
import { describeDate, type IsoDate } from '../domain/time.js';
import { resolvePayRate } from './rates.js';
import type { CostContext } from './types.js';

export type DayOfPayEvent =
  | { kind: 'missed_break'; nurseId: Id; date: IsoDate; break: 'meal' | 'rest' }
  | { kind: 'sent_home'; nurseId: Id; date: IsoDate; scheduledHours: number; hoursWorked: number }
  | { kind: 'call_back'; nurseId: Id; date: IsoDate; hoursWorked: number };

export interface DayOfPayPolicy {
  /** The fewest hours a call-back pays, from the contract. 0 pays the hours worked. */
  callBackMinimumHours: number;
}

export interface DayOfPayLine {
  nurseId: Id;
  date: IsoDate;
  kind: 'missed_meal' | 'missed_rest' | 'reporting_pay' | 'call_back';
  hours: number;
  rate: number;
  amount: number;
  /** "Missed meal on Tue Jul 6" — what the line is for, in a manager's words. */
  note: string;
}

export interface DayOfPay {
  lines: DayOfPayLine[];
  total: number;
  /** Events for nurses with no resolvable pay rate. */
  unpriced: number;
}

const REPORTING_MIN_HOURS = 2;
const REPORTING_MAX_HOURS = 4;

export function priceDayOfEvents(
  events: readonly DayOfPayEvent[],
  ctx: CostContext,
  nurses: readonly Nurse[],
  policy: DayOfPayPolicy,
): DayOfPay {
  const byId = new Map(nurses.map((n) => [n.id, n]));
  const lines: DayOfPayLine[] = [];
  let unpriced = 0;
  const seenBreaks = new Set<string>();
  const callBack = ctx.differentials.find((d) => d.kind === 'call_back' && d.active);

  for (const event of events) {
    const nurse = byId.get(event.nurseId);
    const resolved = nurse ? resolvePayRate(ctx.payRates, nurse, event.date) : undefined;
    if (!resolved) {
      unpriced++;
      continue;
    }
    const base = resolved.rate.hourlyRate;
    const on = describeDate(event.date);
    switch (event.kind) {
      case 'missed_break': {
        const key = `${event.nurseId}|${event.date}|${event.break}`;
        if (seenBreaks.has(key)) break;
        seenBreaks.add(key);
        lines.push({
          nurseId: event.nurseId,
          date: event.date,
          kind: event.break === 'meal' ? 'missed_meal' : 'missed_rest',
          hours: 1,
          rate: base,
          amount: base,
          note: `Missed ${event.break} break on ${on}`,
        });
        break;
      }
      case 'sent_home': {
        const owed = Math.min(
          REPORTING_MAX_HOURS,
          Math.max(REPORTING_MIN_HOURS, event.scheduledHours / 2),
        );
        const hours = Math.max(event.hoursWorked, owed);
        lines.push({
          nurseId: event.nurseId,
          date: event.date,
          kind: 'reporting_pay',
          hours,
          rate: base,
          amount: hours * base,
          note: `Sent home on ${on} after ${event.hoursWorked}h of a ${event.scheduledHours}h shift`,
        });
        break;
      }
      case 'call_back': {
        const hours = Math.max(event.hoursWorked, policy.callBackMinimumHours);
        const rate =
          callBack === undefined
            ? base
            : callBack.mode === 'flat'
              ? base + callBack.amount
              : base * callBack.amount;
        lines.push({
          nurseId: event.nurseId,
          date: event.date,
          kind: 'call_back',
          hours,
          rate,
          amount: hours * rate,
          note: `Called back on ${on} for ${event.hoursWorked}h`,
        });
        break;
      }
    }
  }
  return { lines, total: lines.reduce((t, l) => t + l.amount, 0), unpriced };
}
