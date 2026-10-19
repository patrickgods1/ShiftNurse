/**
 * Low-census cancellation order: who goes home first when there are more nurses on a shift than
 * its patients need.
 *
 * Nearly every nursing contract fixes this order, and a manager deciding it at 05:30 by feel is
 * how one nurse ends up sent home every quiet Sunday. The usual order: those who volunteer to go,
 * then agency and travellers (the unit pays a premium for them), then nurses floated in from
 * another unit, then staff on overtime, then per diem, then the unit's own staff in rotation — the
 * nurse cancelled fewest times so far goes first, then whoever was cancelled longest ago, then the
 * most junior. A float is borrowed help, so contracts send her back before the unit's own staff
 * (D21). The tiers are the unit's policy and may be reordered; the charge nurse is never
 * cancelled, since someone must run the shift. Within the agency, float, overtime and per diem
 * tiers the most junior goes first (reverse `compareSeniority`); volunteers go in the order they
 * offered. Each place carries its reason, as the call-off list's do. A nurse whose removal would
 * leave the shift breaking a hard rule (the only experienced RN beside a new grad, the only
 * holder of a required credential, an orientee's preceptor) is never in the order, with the rule's
 * own words as the reason — the caller passes `removalBreaks`.
 */

import type { Assignment, Id, Nurse } from '../domain/entities.js';
import { compareDates, describeDate, type IsoDate } from '../domain/time.js';
import { compareSeniority } from '../roster/seniority.js';
import type { Violation } from '../rules/types.js';

export type CancellationTier =
  | 'volunteer'
  | 'agency'
  | 'float'
  | 'overtime'
  | 'per_diem'
  | 'rotation';

export const DEFAULT_CANCELLATION_TIERS: readonly CancellationTier[] = [
  'volunteer',
  'agency',
  'float',
  'overtime',
  'per_diem',
  'rotation',
];

/** A nurse's low-census cancellations so far: the ledger's running count and the last date. */
export type CancellationHistory = ReadonlyMap<Id, { count: number; lastOn?: IsoDate }>;

export interface CancellationInput {
  /** The unit whose shift this is; anyone on it homed elsewhere is floated in. */
  unitId: Id;
  /** The shift's roster for the role being reduced. */
  onShift: readonly { nurse: Nurse; assignment: Assignment }[];
  tiers: readonly CancellationTier[];
  /** Nurses who offered to go home, in the order they offered. */
  volunteers: readonly Id[];
  history: CancellationHistory;
  /**
   * Keyed by assignment id: the hard breach sending that nurse home would leave (`removalBreaks`).
   * Absent: nobody is kept for that reason.
   */
  removalBreaks?: ReadonlyMap<Id, Violation>;
}

export interface CancellationPlace {
  nurseId: Id;
  assignmentId: Id;
  tier: CancellationTier;
  reason: string;
}

export interface CancellationOrder {
  /** Who goes first, then next. Cancel from the top until the shift is no longer over. */
  order: CancellationPlace[];
  /** On the shift but never cancelled, with why. */
  excluded: { nurseId: Id; reason: string }[];
}

const nameOf = (nurse: Nurse) => `${nurse.firstName} ${nurse.lastName}`;

function times(n: number): string {
  return `${n} low-census cancellation${n === 1 ? '' : 's'}`;
}

export function cancellationOrder(input: CancellationInput): CancellationOrder {
  const excluded: CancellationOrder['excluded'] = [];
  const pool: { nurse: Nurse; assignment: Assignment }[] = [];
  for (const entry of input.onShift) {
    if (entry.assignment.isCharge) {
      excluded.push({
        nurseId: entry.nurse.id,
        reason: `${nameOf(entry.nurse)} is the charge nurse on this shift.`,
      });
      continue;
    }
    // A volunteer too: offering to go does not make the shift safe without her.
    const breach = input.removalBreaks?.get(entry.assignment.id);
    if (breach) {
      excluded.push({
        nurseId: entry.nurse.id,
        reason: `Sending ${nameOf(entry.nurse)} home would leave the shift breaking a hard rule — ${breach.ruleName}: ${breach.message}`,
      });
    } else pool.push(entry);
  }

  const placed = new Set<Id>();
  const order: CancellationPlace[] = [];
  const place = (
    entry: { nurse: Nurse; assignment: Assignment },
    tier: CancellationTier,
    reason: string,
  ) => {
    placed.add(entry.nurse.id);
    order.push({ nurseId: entry.nurse.id, assignmentId: entry.assignment.id, tier, reason });
  };
  /** Most junior first: the reverse of seniority. */
  const juniorFirst = (entries: typeof pool) =>
    [...entries].sort((a, b) => compareSeniority(b.nurse, a.nurse));
  const open = () => pool.filter((e) => !placed.has(e.nurse.id));

  for (const tier of input.tiers) {
    switch (tier) {
      case 'volunteer':
        for (const id of input.volunteers) {
          const entry = open().find((e) => e.nurse.id === id);
          if (entry) place(entry, tier, `${nameOf(entry.nurse)} offered to go home.`);
        }
        break;
      case 'agency':
        for (const e of juniorFirst(open().filter((e) => e.nurse.employmentType === 'agency'))) {
          place(e, tier, 'Agency staff are cancelled before the unit’s own.');
        }
        break;
      case 'float':
        for (const e of juniorFirst(open().filter((e) => e.nurse.unitId !== input.unitId))) {
          place(
            e,
            tier,
            'Floated in from another unit; floated-in nurses go back before the unit’s own staff.',
          );
        }
        break;
      case 'overtime':
        for (const e of juniorFirst(open().filter((e) => e.assignment.isOvertime))) {
          place(e, tier, 'On overtime for this shift.');
        }
        break;
      case 'per_diem':
        for (const e of juniorFirst(open().filter((e) => e.nurse.employmentType === 'per_diem'))) {
          place(e, tier, 'Per diem staff are cancelled before contracted staff.');
        }
        break;
      case 'rotation': {
        const rest = juniorFirst(open());
        const historyOf = (id: Id) => input.history.get(id) ?? { count: 0 };
        const ranked = [...rest].sort((a, b) => {
          const ha = historyOf(a.nurse.id);
          const hb = historyOf(b.nurse.id);
          if (ha.count !== hb.count) return ha.count - hb.count;
          // Never cancelled, or longest ago, first.
          if (ha.lastOn !== hb.lastOn) {
            if (ha.lastOn === undefined) return -1;
            if (hb.lastOn === undefined) return 1;
            return compareDates(ha.lastOn, hb.lastOn);
          }
          return rest.indexOf(a) - rest.indexOf(b);
        });
        for (const [i, e] of ranked.entries()) {
          const h = historyOf(e.nurse.id);
          const next = ranked[i + 1];
          const tiedWithNext =
            next !== undefined &&
            historyOf(next.nurse.id).count === h.count &&
            historyOf(next.nurse.id).lastOn === h.lastOn;
          const count = h.count === 0 ? 'no low-census cancellations yet' : times(h.count);
          const last = h.lastOn === undefined ? '' : `, last on ${describeDate(h.lastOn)}`;
          const fewest = i === 0 && ranked.length > 1 ? ', the fewest on this shift' : '';
          const junior = tiedWithNext ? `, and junior to ${nameOf(next!.nurse)}` : '';
          place(e, tier, `Rotation: ${count}${last}${fewest}${junior}.`);
        }
        break;
      }
    }
  }
  return { order, excluded };
}
