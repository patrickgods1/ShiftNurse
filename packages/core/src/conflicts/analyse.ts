/**
 * The conflict report, the auto-resolve selector and the time-off what-if.
 *
 * ## Why one entry point
 *
 * `analyseConflicts` runs detection and resolution on one shared engine so the desktop's
 * Requests screen gets conflicts, their options and the summary in one IPC call, computed
 * against one consistent snapshot of the period. Building the engine twice would cost little,
 * but two engines could be handed two different inputs by mistake; one cannot.
 *
 * ## Why auto-resolve is a pure selector
 *
 * `selectAutoResolutions` decides *which* options a policy would take and returns them; it
 * applies nothing. The caller persists the actions inside one transaction and writes the
 * `auto_resolve` audit entry quoting each resolution's description, which is the sentence that
 * gets read back if the decision is challenged. Keeping selection separate from application is
 * also what makes the policy testable without a database.
 *
 * ## Why the what-if copies the input
 *
 * A time-off decision is previewed by flipping the request's status on a copy of the input and
 * detecting again. Approval also lifts the nurse's assignments inside the requested range —
 * the desktop lifts in-range assignments from *draft* periods on approval, and it is those
 * orphaned shifts that surface as the new understaffing. Anything approval cannot lift (a
 * published period, a locked assignment) is what the `scheduled_on_leave` conflict catches.
 * The original input is never touched.
 */

import type { Assignment, Id, TimeOffRequest } from '../domain/entities.js';
import { dateInRange, rangesOverlap } from '../domain/time.js';
import { detectWith } from './detect.js';
import { ConflictEngine } from './engine.js';
import { resolveWith } from './resolve.js';
import type {
  AutoResolvePolicy,
  Conflict,
  ConflictInput,
  ConflictKind,
  ConflictReport,
  ConflictSummary,
  Resolution,
  ResolutionOptions,
  TimeOffImpact,
} from './types.js';

const KINDS: readonly ConflictKind[] = [
  'understaffing',
  'ratio_breach',
  'competing_time_off',
  'fte',
  'credential',
  'budget',
  'scheduled_on_leave',
];

/** Detect, resolve and summarise a period in one pass. */
export function analyseConflicts(
  input: ConflictInput,
  options: ResolutionOptions = {},
): ConflictReport {
  const engine = new ConflictEngine(input);
  const baseline = engine.baseline();
  const conflicts = detectWith(engine, baseline);
  const resolutions = resolveWith(engine, conflicts, options);
  return {
    periodId: input.period.id,
    conflicts,
    resolutions,
    summary: summarise(conflicts, baseline.hardShortfall()),
  };
}

export function summarise(conflicts: readonly Conflict[], hardShortfall: number): ConflictSummary {
  const byKind = {} as Record<ConflictKind, number>;
  for (const kind of KINDS) byKind[kind] = 0;
  let hard = 0;
  let soft = 0;
  for (const c of conflicts) {
    byKind[c.kind]++;
    if (c.severity === 'hard') hard++;
    else soft++;
  }
  return { hard, soft, byKind, hardShortfall };
}

// ---------------------------------------------------------------------------
// Auto-resolve
// ---------------------------------------------------------------------------

/**
 * The resolutions a policy would take on its own, in conflict order. Off → nothing. On → per
 * conflict, its top-ranked option, and only if it closes the conflict entirely, costs no more
 * than `maxCostDelta`, drops the unit fairness score by no more than `maxFairnessDrop`, raises
 * no advisory warning, leaves coverage no worse, and touches no nurse already committed on the
 * same date by an earlier pick. `accept_shortfall` is never taken — leaving a shift short is a decision a person owns —
 * and neither is `deny_time_off`: a denial must carry a stated reason (`recordAuditStrict`
 * refuses one without), and a policy threshold is not a reason a nurse can be given.
 */
export function selectAutoResolutions(
  report: ConflictReport,
  policy: AutoResolvePolicy,
): Resolution[] {
  if (!policy.enabled) return [];
  const committed = new Set<string>();
  const chosen: Resolution[] = [];

  for (const conflict of report.conflicts) {
    const top = report.resolutions.find((r) => r.conflictId === conflict.id);
    if (!top) continue;
    if (top.kind === 'accept_shortfall' || top.kind === 'deny_time_off') continue;
    if (!top.closesConflict) continue;
    // Lifting a shift to clear a leave clash closes that conflict but opens a hole; a policy
    // may fill holes on its own, never dig them.
    if (top.impact.coverage.delta > 0) continue;
    if (top.impact.cost.delta > policy.maxCostDelta) continue;
    if (top.impact.fairness.delta < -policy.maxFairnessDrop) continue;
    if (top.impact.softViolationsIntroduced.length > 0) continue;

    const touches = nurseDates(top);
    if (touches.some((key) => committed.has(key))) continue;
    for (const key of touches) committed.add(key);
    chosen.push(top);
  }
  return chosen;
}

/** `nurseId@date` for every nurse-day a resolution's actions commit. */
function nurseDates(resolution: Resolution): string[] {
  const out: string[] = [];
  for (const action of resolution.actions) {
    switch (action.type) {
      case 'create_assignment':
        out.push(`${action.nurseId}@${action.date}`);
        break;
      case 'move_assignment':
        for (const nurseId of resolution.nurseIds) out.push(`${nurseId}@${action.toDate}`);
        break;
      case 'delete_assignment':
      case 'deny_time_off':
      case 'accept_shortfall':
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Time-off what-if
// ---------------------------------------------------------------------------

export function timeOffImpact(
  input: ConflictInput,
  requestId: Id,
  decision: 'approved' | 'denied',
): TimeOffImpact {
  const request = input.timeOff.find((r) => r.id === requestId);
  if (!request) throw new Error(`Time-off request ${requestId} is not in this period's input`);

  const engine = new ConflictEngine(input);
  const before = engine.baseline();

  const displacedAssignments: Assignment[] =
    decision === 'approved'
      ? before.assignmentsWithin(request.nurseId, request.startDate, request.endDate)
      : [];
  const gone = new Set(displacedAssignments.map((a) => a.id));
  const decided: TimeOffRequest = { ...request, status: decision };
  const after = engine.state(
    input.assignments.filter((a) => !gone.has(a.id)),
    input.timeOff.map((r) => (r.id === requestId ? decided : r)),
  );

  const wasThere = detectWith(engine, before);
  const isThere = detectWith(engine, after);
  const beforeIds = new Set(wasThere.map((c) => c.id));
  const afterIds = new Set(isThere.map((c) => c.id));

  const shortfallBefore = before.hardShortfall();
  const shortfallAfter = after.hardShortfall();

  const competing = input.timeOff
    .filter(
      (r) =>
        r.id !== requestId &&
        r.status === 'pending' &&
        rangesOverlap(r.startDate, r.endDate, request.startDate, request.endDate) &&
        // Only competition inside the period matters to this period's schedule.
        engine.dates.some((d) => dateInRange(d, r.startDate, r.endDate)),
    )
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));

  return {
    request,
    decision,
    introduced: isThere.filter((c) => !beforeIds.has(c.id)),
    cleared: wasThere.filter((c) => !afterIds.has(c.id)),
    displacedAssignments,
    coverage: {
      hardShortfallBefore: shortfallBefore,
      hardShortfallAfter: shortfallAfter,
      delta: shortfallAfter - shortfallBefore,
    },
    competing,
  };
}
