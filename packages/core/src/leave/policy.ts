/**
 * Refusing a leave policy that cannot mean anything before it is stored.
 *
 * A unit's policy decides which FMLA year every request is measured in and how every balance is
 * projected. A fixed year with no start date, tiers out of order or an earning rate of zero would
 * not crash: the projection would quietly accrue nothing or the wrong thing, and the manager
 * would approve leave against a number that was never right. So each fault is caught here, in
 * words the manager can act on, rather than discovered as a wrong balance weeks later.
 */

import type { AccrualRule, LeavePolicy } from '../domain/entities.js';

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function positive(n: number | undefined): boolean {
  return n !== undefined && Number.isFinite(n) && n > 0;
}

function validateFixedYearStart(start: string | undefined): void {
  if (start === undefined || start === '') {
    throw new Error('A fixed FMLA year needs a start date, as month and day (for example 10-01)');
  }
  const match = /^(\d{2})-(\d{2})$/.exec(start);
  const month = match ? Number(match[1]) : 0;
  const day = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]!) {
    throw new Error(`The fixed FMLA year start "${start}" is not a valid MM-DD date`);
  }
  // 29 February would put the year's start on a different day in three years out of four.
  if (month === 2 && day === 29) {
    throw new Error('A fixed FMLA year cannot start on 29 February; most years do not have one');
  }
}

function validateRule(rule: AccrualRule): void {
  const label = `The ${rule.balanceType} accrual rule`;
  if (rule.tiers.length === 0) throw new Error(`${label} has no earning rates`);
  if (rule.tiers[0]!.fromYearsOfService !== 0) {
    throw new Error(`${label} must start at 0 years of service, or new staff earn nothing`);
  }
  for (let i = 1; i < rule.tiers.length; i++) {
    if (!(rule.tiers[i]!.fromYearsOfService > rule.tiers[i - 1]!.fromYearsOfService)) {
      throw new Error(
        `${label} must list its tiers in ascending years of service, with no repeats`,
      );
    }
  }
  for (const tier of rule.tiers) {
    const byPeriod = tier.hoursPerPayPeriod !== undefined;
    const byHour = tier.hoursPerAccruedHour !== undefined;
    if (byPeriod && byHour) {
      throw new Error(
        `${label} has a tier earning by pay period and by hour worked; choose one, not both`,
      );
    }
    if (!byPeriod && !byHour) {
      throw new Error(
        `${label} has a tier with no rate; give hours per pay period or per hour worked, either one`,
      );
    }
    if (!positive(tier.hoursPerPayPeriod ?? tier.hoursPerAccruedHour)) {
      throw new Error(`${label} has an earning rate that is not a number greater than zero`);
    }
  }
  if (rule.balanceCapHours !== undefined && !positive(rule.balanceCapHours)) {
    throw new Error(`${label} has a balance cap that is not a number greater than zero`);
  }
  if (rule.carryoverCapHours !== undefined && !positive(rule.carryoverCapHours)) {
    throw new Error(`${label} has a carryover cap that is not a number greater than zero`);
  }
}

/** Throws an Error a manager can read when the policy is unusable; returns nothing otherwise. */
export function validateLeavePolicy(policy: LeavePolicy): void {
  if (policy.fmla.yearMethod === 'fixed') validateFixedYearStart(policy.fmla.fixedYearStart);
  for (const rule of policy.accrual) validateRule(rule);
}
