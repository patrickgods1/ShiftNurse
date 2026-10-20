/** Conflicts and exchanges: analysis, the auto-resolve pass, and deciding a proposed swap. */

import {
  analyseConflicts,
  type ConflictReport,
  type ExchangeApplication,
  type ExchangeEvaluation,
  type ExchangeProposal,
  evaluateExchange,
  type Id,
  independentFixes,
  planExchange,
  type Resolution,
  selectAutoResolutions,
} from '@shiftnurse/core';
import {
  applyResolution,
  approveSwap,
  type DbLike,
  getConflictPolicy,
  getSwap,
  type ShiftNurseDb,
  transact,
} from '@shiftnurse/db';
import type { AutoResolveResult } from '../../shared/api.js';

import { userFacingMessage } from '../ipc-errors.js';
import { ACTOR, buildConflictInput, periodOrThrow } from './context.js';
import { requireActiveRecipient, requireOnRoster } from './schedule.js';

export function analyse(db: DbLike, periodId: Id): ConflictReport {
  return analyseConflicts(buildConflictInput(db, periodId));
}

/**
 * Each resolution is applied in its own transaction, and the period is re-analysed between
 * batches: applying one option can close (or change) a neighbouring conflict, and a stale option
 * must be dropped rather than double-booked. A batch is only the fixes that cannot interact
 * (`independentFixes`: different nurses, dates at least two days apart) — re-analysing after
 * every single fix took minutes on a busy period. The pass stops at the first refusal so a
 * surprising state is left for the manager to see, not papered over: the result's `stoppedAt` names
 * the refused fix and its message, while `applied` keeps the fixes that already landed.
 */
export function autoResolve(
  db: ShiftNurseDb,
  periodId: Id,
  apply: typeof applyResolution = applyResolution,
): AutoResolveResult {
  const period = periodOrThrow(db, periodId);
  const policy = getConflictPolicy(db, period.unitId);
  const applied: Resolution[] = [];
  if (!policy.enabled) return { applied, report: analyse(db, periodId) };

  const seen = new Set<string>();
  for (;;) {
    const input = buildConflictInput(db, periodId);
    const report = analyseConflicts(input);
    const fresh = selectAutoResolutions(report, policy).filter((r) => !seen.has(r.id));
    const batch = independentFixes(fresh, input.assignments);
    if (batch.length === 0) return { applied, report };
    for (const next of batch) {
      seen.add(next.id);
      // Earlier fixes are already committed; a refusal here must not discard the record of them.
      try {
        transact(db, (tx) => apply(tx, periodId, next, ACTOR, { auto: true }));
      } catch (err) {
        console.error('[auto-resolve] stopped:', err);
        return {
          applied,
          report: analyse(db, periodId),
          stoppedAt: { resolution: next, message: userFacingMessage(err) },
        };
      }
      applied.push(next);
    }
  }
}

/**
 * Applies the option with this id as the analysis offers it now, inside the transaction that
 * writes it. The renderer's card is only a pointer: executing its payload would let a stale card
 * or a forged one reach the audit as fact. A refusal precedes `applyResolution`, so it audits nothing.
 */
export function resolveConflict(
  db: ShiftNurseDb,
  periodId: Id,
  resolutionId: string,
  reason: string,
): Resolution {
  return transact(db, (tx) => {
    const fresh = analyseConflicts(buildConflictInput(tx, periodId));
    const chosen = fresh.resolutions.find((r) => r.id === resolutionId);
    if (!chosen) {
      throw new Error(
        'That option no longer applies: the schedule has changed since it was offered. ' +
          'The list has been refreshed; pick again.',
      );
    }
    return applyResolution(tx, periodId, chosen, ACTOR, { auto: false, reason }).resolution;
  });
}

/**
 * Approve a proposed swap. Re-evaluated from the stored swap, not from anything the renderer
 * sent: a verdict is only trustworthy when it is computed here, against the period's current
 * state, immediately before the write that acts on it. `warn` goes through as an override
 * (which requires the reason `approveSwap` records); `blocked` never does.
 */
export function approveExchange(db: ShiftNurseDb, id: Id, reason?: string) {
  return transact(db, (tx) => {
    const swap = getSwap(tx, id);
    if (!swap) throw new Error('That shift swap was not found; it may have been withdrawn.');
    if (swap.status !== 'proposed') {
      throw new Error(`This shift swap is already ${swap.status}; there is nothing to decide.`);
    }
    const proposal: ExchangeProposal = {
      kind: swap.kind,
      requestingNurseId: swap.requestingNurseId,
      counterpartyNurseId: swap.counterpartyNurseId,
      offeredAssignmentId: swap.offeredAssignmentId,
      requestedAssignmentId: swap.requestedAssignmentId,
    };
    // Both nurses must be on the period's roster before the exchange can even be judged.
    requireOnRoster(tx, swap.periodId, swap.requestingNurseId);
    if (swap.counterpartyNurseId) requireOnRoster(tx, swap.periodId, swap.counterpartyNurseId);
    // Each nurse receiving a shift must still be on staff: the counterparty always, and in a
    // trade the requester too, since she takes the counterparty's shift in return.
    requireActiveRecipient(tx, swap.counterpartyNurseId);
    if (swap.kind === 'trade') requireActiveRecipient(tx, swap.requestingNurseId);
    const exchangeInput = { ...buildConflictInput(tx, swap.periodId), proposal };
    const evaluation: ExchangeEvaluation = evaluateExchange(exchangeInput);
    if (evaluation.verdict === 'blocked') {
      throw new Error(
        `Exchange blocked: ${evaluation.blockers.join('; ') || 'a hard rule would break'}`,
      );
    }
    const overrode = evaluation.verdict === 'warn';
    const application: ExchangeApplication = planExchange(exchangeInput);
    return approveSwap(tx, id, application, ACTOR, { overrode, reason });
  });
}
