/**
 * One open call-off: the ranked replacement search, the call log so far, and the two ways this
 * ends without a backfill — mark uncovered (the shift ran short) or cancel (the nurse turned up,
 * or it was a mistake). The ranking itself is `dayOf.replacements`, judged live against the
 * period's own rule-set snapshot in main; this card only renders what it returns.
 */

import type { CallOffView } from '@shared/api.js';
import type { CallOutcome, Id } from '@shiftnurse/core';
import { useMemo, useState } from 'react';
import { useNurses } from '../../api.js';
import {
  useBackfill,
  useCancelCallOff,
  useLogCall,
  useMarkUncovered,
  useReplacements,
} from '../../api-dayof.js';
import { AsyncState } from '../../components/async-state.js';
import { formatDateWithWeekday } from '../../format.js';
import { formatSignedDollars } from '../../money.js';
import { ReasonDialog } from '../requests/reason-dialog.js';
import { DANGER, INPUT, SECONDARY, SMALL } from '../requests/ui.js';
import { payTierLabel, payTierTone, TONE_CLASSES } from './tier-pill.js';

const NON_ACCEPTED_OUTCOMES: readonly Exclude<CallOutcome, 'accepted'>[] = [
  'declined',
  'no_answer',
  'left_message',
];

const OUTCOME_LABEL: Record<Exclude<CallOutcome, 'accepted'>, string> = {
  declined: 'Declined',
  no_answer: 'No answer',
  left_message: 'Left message',
  ineligible: 'Ineligible',
};

export function CallOffCard({ unitId, callOff }: { unitId: Id; callOff: CallOffView }) {
  const replacementsQuery = useReplacements(callOff.callOff.id);
  const nursesQuery = useNurses(unitId);
  const nursesById = useMemo(
    () => new Map((nursesQuery.data ?? []).map((n) => [n.id, n])),
    [nursesQuery.data],
  );
  const backfill = useBackfill(unitId);
  const logCall = useLogCall(unitId);
  const markUncovered = useMarkUncovered(unitId);
  const cancelCallOff = useCancelCallOff(unitId);

  const [outcomeByNurse, setOutcomeByNurse] = useState<
    Record<Id, Exclude<CallOutcome, 'accepted'>>
  >({});
  const [uncovering, setUncovering] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const report = replacementsQuery.data;

  function nurseLabel(nurseId: Id): string {
    const n = nursesById.get(nurseId);
    return n ? `${n.lastName}, ${n.firstName}` : nurseId;
  }

  return (
    <div className="rounded-md border border-border bg-surface p-4" data-testid="call-off-card">
      <div>
        <p className="font-medium text-text">
          {callOff.nurse.lastName}, {callOff.nurse.firstName} ({callOff.nurse.role}) —{' '}
          {callOff.shiftType.abbreviation} {formatDateWithWeekday(callOff.callOff.date)}
        </p>
        {callOff.callOff.reason !== undefined ? (
          <p className="text-sm text-text-muted">{callOff.callOff.reason}</p>
        ) : null}
        <p className="text-xs text-text-muted">
          Reported {new Date(callOff.callOff.reportedAt).toLocaleString()}
        </p>
      </div>

      {report !== undefined ? (
        <p className="mt-2 text-sm text-warn">
          Shift is {report.shortfall} nurse-slot(s) short with them gone
        </p>
      ) : null}

      <div className="mt-3" data-testid="replacement-list">
        {replacementsQuery.isPending ? (
          <AsyncState status="loading" label="Ranking replacements" />
        ) : replacementsQuery.isError ? (
          <AsyncState
            status="error"
            label="Could not rank replacements"
            error={replacementsQuery.error}
          />
        ) : report !== undefined && report.candidates.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {report.candidates.map((c) => {
              const outcome = outcomeByNurse[c.nurseId] ?? 'declined';
              return (
                <li key={c.nurseId} className="rounded-md border border-border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-text-muted">#{c.rank}</span>
                    <span className="text-sm text-text">{c.label}</span>
                    {c.phone !== undefined ? (
                      <span className="text-xs text-text-muted">{c.phone}</span>
                    ) : null}
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${TONE_CLASSES[payTierTone(c.payTier)]}`}
                    >
                      {payTierLabel(c.payTier)}
                    </span>
                    <span className="text-xs text-text-muted">
                      {formatSignedDollars(c.cost.delta)}
                      {c.cost.unpriced ? ' (unpriced)' : ''}
                    </span>
                    <span className="text-xs text-text-muted">
                      burden {c.burdenIndex.toFixed(2)}
                    </span>
                    <span className="text-xs text-text-muted">
                      {c.lastCalledAt !== undefined
                        ? new Date(c.lastCalledAt).toLocaleString()
                        : 'never called'}
                    </span>
                  </div>
                  {c.softViolationsIntroduced.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5 text-xs text-text-muted">
                      {c.softViolationsIntroduced.map((v) => (
                        <li key={v.ruleId}>{v.message}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={SMALL}
                      disabled={backfill.isPending}
                      onClick={() =>
                        backfill.mutate({ callOffId: callOff.callOff.id, nurseId: c.nurseId })
                      }
                    >
                      Accept
                    </button>
                    <select
                      aria-label={`Call outcome for ${c.label}`}
                      className={INPUT}
                      value={outcome}
                      onChange={(e) =>
                        setOutcomeByNurse((m) => ({
                          ...m,
                          [c.nurseId]: e.target.value as Exclude<CallOutcome, 'accepted'>,
                        }))
                      }
                    >
                      {NON_ACCEPTED_OUTCOMES.map((o) => (
                        <option key={o} value={o}>
                          {OUTCOME_LABEL[o]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={SMALL}
                      disabled={logCall.isPending}
                      onClick={() =>
                        logCall.mutate({
                          callOffId: callOff.callOff.id,
                          nurseId: c.nurseId,
                          outcome,
                        })
                      }
                    >
                      Log
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No eligible replacements.</p>
        )}
      </div>

      {report !== undefined && report.excluded.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-text-muted">
            Not eligible ({report.excluded.length})
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-text-muted">
            {report.excluded.map((x) => (
              <li key={x.nurseId}>
                {x.label} — {x.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="mt-3 border-t border-border pt-2">
        <p className="text-xs font-medium text-text-muted">Call log</p>
        {callOff.attempts.length === 0 ? (
          <p className="mt-1 text-xs text-text-muted">No calls logged yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-text-muted">
            {callOff.attempts.map((a) => (
              <li key={a.id}>
                {new Date(a.attemptedAt).toLocaleString()} — {nurseLabel(a.nurseId)} — {a.outcome}
                {a.notes !== undefined ? ` — ${a.notes}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={SECONDARY} onClick={() => setUncovering(true)}>
          Mark uncovered
        </button>
        <button type="button" className={DANGER} onClick={() => setCancelling(true)}>
          Cancel call-off
        </button>
      </div>

      <ReasonDialog
        open={uncovering}
        onOpenChange={setUncovering}
        title="Mark shift uncovered"
        description="Nobody was found before the shift started; the shift ran short."
        confirmLabel="Mark uncovered"
        destructive
        pending={markUncovered.isPending}
        error={markUncovered.error}
        onConfirm={(reason) =>
          markUncovered.mutate(
            { callOffId: callOff.callOff.id, reason },
            { onSuccess: () => setUncovering(false) },
          )
        }
      />
      <ReasonDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel call-off"
        description="The nurse turned up after all, or this was logged in error."
        confirmLabel="Cancel call-off"
        destructive
        pending={cancelCallOff.isPending}
        error={cancelCallOff.error}
        onConfirm={(reason) =>
          cancelCallOff.mutate(
            { callOffId: callOff.callOff.id, reason },
            { onSuccess: () => setCancelling(false) },
          )
        }
      />
    </div>
  );
}
