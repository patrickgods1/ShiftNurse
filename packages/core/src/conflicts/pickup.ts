/**
 * The row a nurse gets when she picks up a shift someone else held.
 *
 * ## Why one planner
 *
 * An exchange, a call-off replacement and a conflict resolution each built "the row the recipient
 * gets" on their own, and they disagreed: an exchange copied the giver's charge flag onto a nurse
 * who could not take charge (the shift then read as having no charge nurse and the trade was
 * blocked, though an eligible nurse stood on the same shift), and copied the giver's overtime flag
 * onto a nurse on straight time (blocked under no-mandatory-overtime, or authorised overtime on
 * payroll for a straight-time shift). This is the one place a pickup's `isCharge` and `isOvertime`
 * are decided for exchanges and call-offs, so the two cannot drift again. A resolution's own
 * candidates (`candidates.ts`) already check eligibility and are left to themselves.
 *
 * ## Charge
 *
 * Charge goes to the recipient only if she can take it (`canTakeCharge`). Otherwise it moves to
 * the most senior unlocked nurse already on the shift who can — an update to her row, which the
 * caller must write in the same change, or the grid turns red the moment the approval lands. With
 * nobody to take it, the shift is left without, and the coverage rule says so in `hard`.
 *
 * ## Overtime
 *
 * The recipient starts at straight time: the giver's overtime flag described the giver's week,
 * not hers. The row is flagged authorised overtime only when straight time broke nothing but
 * `unauthorised_overtime` — the same "straight time, else authorised overtime" shape a resolution
 * uses. Breaches are judged introduced or worsened, so a pickup that deepens a cap already
 * exceeded is not waved through because the violation's key did not change.
 */

import type { Assignment, Id, Nurse, TimeOffRequest } from '../domain/entities.js';
import type { IsoDate } from '../domain/time.js';
import { compareSeniority } from '../roster/seniority.js';
import { canTakeCharge } from '../rules/coverage-rules.js';
import type { Violation } from '../rules/types.js';
import { diffViolations } from '../rules/violation-diff.js';
import type { ConflictEngine, SimState } from './engine.js';

export interface PickupRequest {
  recipient: Nurse;
  date: IsoDate;
  shiftTypeId: Id;
  periodId: Id;
  source: Assignment['source'];
  /** The shift needs this pickup, or someone on the shift, to carry the charge flag. */
  needsCharge: boolean;
  notes?: string;
  /** Id given to the simulated row; never written. */
  trialId: string;
}

export interface PickupPlan {
  row: Omit<Assignment, 'id'>;
  /** A row already on the shift that takes charge because the recipient cannot. Before the change. */
  chargeMovedTo?: Assignment;
  /** `working` with the charge move and the pickup applied (the pickup under `trialId`). */
  assignments: Assignment[];
  after: SimState;
  /** Hard breaches the pickup introduces or worsens: the recipient's, and the shift's (around). */
  hard: Violation[];
  soft: Violation[];
  /** The row is flagged authorised overtime because straight time broke only that. */
  forcedOvertime: boolean;
}

export function planPickup(
  engine: ConflictEngine,
  before: SimState,
  working: readonly Assignment[],
  timeOff: readonly TimeOffRequest[],
  request: PickupRequest,
): PickupPlan {
  const { recipient, date, shiftTypeId } = request;

  let isCharge = false;
  let chargeMovedTo: Assignment | undefined;
  let trialWorking: Assignment[] = [...working];
  if (request.needsCharge) {
    if (canTakeCharge(recipient, engine.coverageParams)) {
      isCharge = true;
    } else {
      chargeMovedTo = working
        .filter(
          (a) =>
            a.date === date &&
            a.shiftTypeId === shiftTypeId &&
            !a.isLocked &&
            !a.isCharge &&
            a.nurseId !== recipient.id &&
            canTakeCharge(engine.nurse(a.nurseId), engine.coverageParams),
        )
        .sort((a, b) => compareSeniority(engine.nurse(a.nurseId), engine.nurse(b.nurseId)))[0];
      if (chargeMovedTo) {
        const moved = chargeMovedTo;
        trialWorking = working.map((a) => (a.id === moved.id ? { ...a, isCharge: true } : a));
      }
    }
  }

  const attempt = (isOvertime: boolean): Omit<PickupPlan, 'forcedOvertime'> => {
    const trial: Assignment = {
      id: request.trialId,
      periodId: request.periodId,
      nurseId: recipient.id,
      shiftTypeId,
      date,
      source: request.source,
      isLocked: false,
      isCharge,
      isOvertime,
      ...(request.notes ? { notes: request.notes } : {}),
    };
    const assignments = [...trialWorking, trial];
    const after = engine.state(assignments, timeOff);
    const nurseDiff = diffViolations(
      before.nurseViolations(recipient.id),
      after.nurseViolations(recipient.id),
    );
    const shiftDiff = diffViolations(
      before.shiftViolationsAround(date, shiftTypeId),
      after.shiftViolationsAround(date, shiftTypeId),
    );
    const found = [nurseDiff, shiftDiff].flatMap((d) => [
      ...d.introduced,
      ...d.worsened.map((w) => w.after),
    ]);
    const { id: _trialId, ...row } = trial;
    return {
      row,
      ...(chargeMovedTo ? { chargeMovedTo } : {}),
      assignments,
      after,
      hard: found.filter((v) => v.severity === 'hard'),
      soft: found.filter((v) => v.severity === 'soft'),
    };
  };

  const straight = attempt(false);
  if (straight.hard.length === 0) return { ...straight, forcedOvertime: false };
  if (straight.hard.every((v) => v.code === 'unauthorised_overtime')) {
    return { ...attempt(true), forcedOvertime: true };
  }
  return { ...straight, forcedOvertime: false };
}
