/** Conflicts and exchanges: analysis, the auto-resolve pass, and deciding a proposed swap. */

import {
  analyseConflicts,
  type ConflictReport,
  type ExchangeApplication,
  type ExchangeEvaluation,
  type ExchangeProposal,
  evaluateExchange,
  type Id,
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

import { ACTOR, buildConflictInput, periodOrThrow } from './context.js';

export function analyse(db: DbLike, periodId: Id): ConflictReport {
  return analyseConflicts(buildConflictInput(db, periodId));
}

/**
 * Each resolution is applied in its own transaction and the period is re-analysed between
 * them: applying one option can close (or change) a neighbouring conflict, and a stale option
 * must be dropped rather than double-booked. The pass stops at the first refusal so a
 * surprising state is left for the manager to see, not papered over.
 */
export function autoResolve(db: ShiftNurseDb, periodId: Id): AutoResolveResult {
  const period = periodOrThrow(db, periodId);
  const policy = getConflictPolicy(db, period.unitId);
  const applied: Resolution[] = [];
  if (!policy.enabled) return { applied, report: analyse(db, periodId) };

  const seen = new Set<string>();
  for (;;) {
    const report = analyse(db, periodId);
    const next = selectAutoResolutions(report, policy).find((r) => !seen.has(r.id));
    if (!next) return { applied, report };
    seen.add(next.id);
    transact(db, (tx) => applyResolution(tx, periodId, next, ACTOR, { auto: true }));
    applied.push(next);
  }
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
    if (!swap) throw new Error(`Shift swap ${id} not found`);
    if (swap.status !== 'proposed') {
      throw new Error(`Shift swap ${id} is ${swap.status}, not proposed; nothing to decide`);
    }
    const proposal: ExchangeProposal = {
      kind: swap.kind,
      requestingNurseId: swap.requestingNurseId,
      counterpartyNurseId: swap.counterpartyNurseId,
      offeredAssignmentId: swap.offeredAssignmentId,
      requestedAssignmentId: swap.requestedAssignmentId,
    };
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
