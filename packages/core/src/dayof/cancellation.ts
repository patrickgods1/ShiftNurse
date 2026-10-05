/**
 * Low-census cancellation order: who goes home first when there are more nurses on a shift than
 * its patients need.
 *
 * Nearly every nursing contract fixes this order, and a manager deciding it at 05:30 by feel is
 * how one nurse ends up sent home every quiet Sunday. The usual order: those who volunteer to go,
 * then agency and travellers (the unit pays a premium for them), then staff on overtime, then per
 * diem, then the unit's own staff in rotation — the nurse cancelled fewest times so far goes
 * first, then whoever was cancelled longest ago, then the most junior. The tiers are the unit's
 * policy and may be reordered; the charge nurse is never cancelled, since someone must run the
 * shift. Within the agency, overtime and per diem tiers the most junior goes first (reverse
 * `seniorityOrder`); volunteers go in the order they offered. Each place carries its reason, as
 * the call-off list's do.
 */

import type { Assignment, Id, Nurse } from '../domain/entities.js';
import { compareDates, describeDate, type IsoDate } from '../domain/time.js';
import { seniorityOrder } from '../leave/bidding.js';

export type CancellationTier = 'volunteer' | 'agency' | 'overtime' | 'per_diem' | 'rotation';

export const DEFAULT_CANCELLATION_TIERS: readonly CancellationTier[] = [
  'volunteer',
  'agency',
  'overtime',
  'per_diem',
  'rotation',
];

/** A nurse's low-census cancellations so far: the ledger's running count and the last date. */
export type CancellationHistory = ReadonlyMap<Id, { count: number; lastOn?: IsoDate }>;

export interface CancellationInput {
  /** The shift's roster for the role being reduced. */
  onShift: readonly { nurse: Nurse; assignment: Assignment }[];
  tiers: readonly CancellationTier[];
  /** Nurses who offered to go home, in the order they offered. */
  volunteers: readonly Id[];
  history: CancellationHistory;
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
  const juniorFirst = (entries: typeof pool) => {
    const seniority = seniorityOrder(entries.map((e) => e.nurse)).map((n) => n.id);
    return [...entries].sort(
      (a, b) => seniority.indexOf(b.nurse.id) - seniority.indexOf(a.nurse.id),
    );
  };
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
