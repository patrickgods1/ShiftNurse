/**
 * What the nurse has to take leave from: shown in the request form and again when deciding. A PTO
 * or sick request is measured against the balance payroll gave the manager; an FMLA request
 * against the 12 work weeks and the two eligibility tests. These are warnings in the manager's
 * words and never stop the request — payroll's figure can be stale, and the manager may know a
 * certification has come in. The sums are made in main; nothing here counts hours.
 */

import type { Id, IsoDate, TimeOffType } from '@shiftnurse/core';
import { useLeaveRequestCheck } from '../../api-leave-balances.js';
import { formatDate } from '../../format.js';

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
  const { balance, noBalanceFor, fmla } = check;
  if (!balance && !noBalanceFor && !fmla) return null;

  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-border bg-bg p-2 text-xs text-text-muted"
      data-testid="leave-standing"
    >
      {balance ? (
        <>
          <p>
            {balance.type === 'pto' ? 'PTO' : 'Sick'} balance: {balance.balanceHours} hours, as of{' '}
            {formatDate(balance.asOf)}.
          </p>
          {balance.check.ok ? null : (
            <p role="alert" className="font-medium text-warn">
              {balance.check.message}
            </p>
          )}
        </>
      ) : null}
      {noBalanceFor ? (
        <p>
          No {noBalanceFor === 'pto' ? 'PTO' : 'sick'} balance is recorded for this nurse, so the
          request cannot be checked. Enter it on the Roster.
        </p>
      ) : null}
      {fmla ? (
        <>
          <p>
            FMLA: {fmla.remainingHours} hours left of 12 work weeks ({fmla.weeklyHours} hours a
            week); this request uses {fmla.requestHours}.
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
