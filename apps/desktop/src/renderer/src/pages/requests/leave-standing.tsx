/**
 * What the nurse has to take leave from: shown in the request form and again when deciding. A
 * request on a balance (PTO, annual, sick, comp time) is measured against what the nurse will
 * have on its first day — payroll's figure carried forward, with the breakdown underneath so the
 * manager can see where the difference came from; an FMLA request against the entitlement under
 * the unit's regime and the eligibility tests; a California pregnancy disability request against
 * its own four months. A balance whose rule caps yearly use (California sick leave) also warns
 * when the request passes the cap, however much is held. These are warnings in the manager's words and
 * never stop the request — payroll's figure can be stale, and the manager may know a
 * certification has come in. The sums are made in main; nothing here counts hours.
 */

import type { LeaveRequestCheck } from '@shared/api.js';
import {
  type FmlaEntitlementBasis,
  type FmlaRegime,
  type Id,
  type IsoDate,
  TIME_OFF_TYPE_LABELS,
  type TimeOffType,
} from '@shiftnurse/core';
import { useLeaveRequestCheck } from '../../api-leave-balances.js';
import { formatDate } from '../../format.js';

const REGIME_LABEL: Record<FmlaRegime, string> = {
  title5: 'Title 5 (federal)',
  title1: 'Title I',
};

const BASIS_LABEL: Record<FmlaEntitlementBasis, string> = {
  contract: '12 × usual week',
  average: '12 × average week over the last year',
  title5_tour: '6 × biweekly tour',
};

/** "Payroll: 100 h on 1 Oct · +24 accrued · −8 approved since", zero parts left out. */
function payrollLine(balance: NonNullable<LeaveRequestCheck['balance']>): string {
  const parts = [`Payroll: ${balance.balanceHours} h on ${formatDate(balance.asOf)}`];
  if (balance.accruedHours !== 0) parts.push(`+${balance.accruedHours} accrued`);
  if (balance.usedHours !== 0) parts.push(`−${balance.usedHours} approved since`);
  if (balance.forfeitedHours !== 0) parts.push(`−${balance.forfeitedHours} forfeited at year end`);
  return parts.join(' · ');
}

export function LeaveStanding({
  nurseId,
  type,
  start,
  end,
  paidHours,
}: {
  nurseId: Id | undefined;
  type: TimeOffType;
  start: IsoDate | undefined;
  end: IsoDate | undefined;
  paidHours: number;
}) {
  const query = useLeaveRequestCheck(
    nurseId && start && end ? { nurseId, type, start, end, paidHours } : undefined,
  );
  const check = query.data;
  if (!check) return null;
  const { balance, noBalanceFor, fmla, pdl } = check;
  if (!balance && !noBalanceFor && !fmla && !pdl) return null;

  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-border bg-bg p-2 text-xs text-text-muted"
      data-testid="leave-standing"
    >
      {balance ? (
        <>
          <p>
            {TIME_OFF_TYPE_LABELS[balance.type]}: {balance.projectedHours} h projected on{' '}
            {formatDate(start as IsoDate)}.
          </p>
          <p className="text-[11px]">{payrollLine(balance)}</p>
          {balance.check.ok ? null : (
            <p role="alert" className="font-medium text-warn">
              {balance.check.message}
            </p>
          )}
          {balance.useCap ? (
            <p role="alert" className="font-medium text-warn">
              {balance.usedThisYearHours} hours used this leave year; this request would take use{' '}
              {balance.useCap.overBy} past the {balance.useCap.capHours}-hour yearly cap.
            </p>
          ) : null}
        </>
      ) : null}
      {noBalanceFor ? (
        <p>
          No {TIME_OFF_TYPE_LABELS[noBalanceFor]} balance is recorded for this nurse, so the request
          cannot be checked. Enter it on the Roster.
        </p>
      ) : null}
      {pdl ? (
        <>
          <p>
            Pregnancy disability leave: {pdl.remainingHours} hours left of {pdl.entitlementHours}{' '}
            (four months of a {pdl.weeklyHours}-hour week); this request uses {pdl.requestHours}.
          </p>
          <p className="text-[11px]">
            {pdl.usedHours} hours taken in the 12 months {formatDate(pdl.period.from)} to{' '}
            {formatDate(pdl.period.to)}.
          </p>
          {pdl.requestHours > pdl.remainingHours ? (
            <p role="alert" className="font-medium text-warn">
              This request uses {pdl.requestHours} hours; only {pdl.remainingHours} are left.
            </p>
          ) : null}
        </>
      ) : null}
      {fmla ? (
        <>
          <p>
            FMLA, {REGIME_LABEL[fmla.regime]}: {fmla.remainingHours} hours left of{' '}
            {fmla.entitlementHours} ({BASIS_LABEL[fmla.basis]}); this request uses{' '}
            {fmla.requestHours}.
          </p>
          <p className="text-[11px]">
            Counted in the 12 months {formatDate(fmla.period.from)} to {formatDate(fmla.period.to)}.
          </p>
          {fmla.requestHours > fmla.remainingHours ? (
            <p role="alert" className="font-medium text-warn">
              This request uses {fmla.requestHours} hours; only {fmla.remainingHours} are left.
            </p>
          ) : null}
          {fmla.eligibility.eligible ? (
            <p>Meets the length-of-service and hours tests.</p>
          ) : (
            <p role="alert" className="font-medium text-warn">
              {fmla.eligibility.reason}
            </p>
          )}
          {fmla.certified ? null : (
            <p>No FMLA certification on file covers the first day (Roster › the nurse).</p>
          )}
        </>
      ) : null}
    </div>
  );
}
