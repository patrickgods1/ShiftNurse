/**
 * Float rotation: who is sent to another unit for a shift when this one has to give up a nurse.
 *
 * Union contracts (VA–NNU Master Agreement Art. 12 and most others) fix the order: volunteers
 * first, then a rotation so the same junior nurse is not floated every time, the most junior
 * going first among equals. Orientees are never floated, and neither is the charge nurse, since
 * someone must run the shift. A manager choosing by memory floats whoever is quiet about it;
 * this ranks from the record instead, and each place carries its reason so "why me?" has an
 * answer. A nurse's objection (not competent on the receiving unit) is recorded elsewhere and
 * never changes this order. A nurse whose removal would leave the shift breaking a hard rule (the
 * only experienced RN beside a new grad, the only holder of a required credential, an orientee's
 * preceptor) is never in the order, with the rule's own words as the reason — the caller passes
 * `removalBreaks`.
 *
 * Only mandated floats count against the rotation: a nurse who volunteered did the unit a favour
 * and must not be passed over next time because of it.
 */

import type { FloatRecord, Id, Nurse, Preceptorship } from '../domain/entities.js';
import { compareDates, describeDate, type IsoDate } from '../domain/time.js';
import { compareSeniority } from '../roster/seniority.js';
import type { Violation } from '../rules/types.js';

export interface FloatOrderInput {
  date: IsoDate;
  /** Nurses on the shift, of the role being floated, with whether each is the shift's charge nurse. */
  onShift: readonly { nurse: Nurse; assignmentId: Id; isCharge: boolean }[];
  /** Nurses who offered to float, in the order they offered. */
  volunteers: readonly Id[];
  preceptorships: readonly Preceptorship[];
  /** The unit's float history (main passes the last 365 days). */
  history: readonly FloatRecord[];
  /**
   * Keyed by assignment id: the hard breach floating that nurse off would leave (`removalBreaks`).
   * Absent: nobody is kept for that reason.
   */
  removalBreaks?: ReadonlyMap<Id, Violation>;
}

export interface FloatPlace {
  nurseId: Id;
  rank: number;
  basis: 'volunteer' | 'rotation';
  reason: string;
}

export interface FloatOrder {
  /** Who floats first, then next. */
  order: FloatPlace[];
  /** On the shift but never floated, with why. */
  excluded: { nurseId: Id; reason: string }[];
}

/** Main wraps the reason as `${name}: ${reason}.`, so a message's own full stop would double. */
const withoutFinalPeriod = (text: string) => text.replace(/\.$/, '');

export function floatOrder(input: FloatOrderInput): FloatOrder {
  const excluded: FloatOrder['excluded'] = [];
  const pool: Nurse[] = [];
  for (const { nurse, assignmentId, isCharge } of input.onShift) {
    const inOrientation = input.preceptorships.some(
      (p) =>
        p.orienteeId === nurse.id &&
        compareDates(p.startDate, input.date) <= 0 &&
        compareDates(input.date, p.endDate) <= 0,
    );
    if (isCharge) excluded.push({ nurseId: nurse.id, reason: 'Charge nurse for the shift' });
    else if (!nurse.isFloatEligible)
      excluded.push({ nurseId: nurse.id, reason: 'Not float-eligible' });
    else if (inOrientation) {
      excluded.push({ nurseId: nurse.id, reason: 'In orientation; orientees are not floated' });
    } else {
      const breach = input.removalBreaks?.get(assignmentId);
      if (breach) {
        excluded.push({
          nurseId: nurse.id,
          reason: `Needed on this shift — floating them would break ${breach.ruleName}: ${withoutFinalPeriod(breach.message)}`,
        });
      } else pool.push(nurse);
    }
  }

  const order: FloatPlace[] = [];
  const placed = new Set<Id>();
  for (const id of input.volunteers) {
    const nurse = pool.find((n) => n.id === id);
    if (!nurse || placed.has(id)) continue;
    placed.add(id);
    order.push({ nurseId: id, rank: order.length + 1, basis: 'volunteer', reason: 'Volunteered' });
  }

  const standing = (id: Id) => {
    const mine = input.history.filter((r) => r.nurseId === id && !r.volunteered);
    let lastOn: IsoDate | undefined;
    for (const r of mine)
      if (lastOn === undefined || compareDates(r.date, lastOn) > 0) lastOn = r.date;
    return { count: mine.length, lastOn };
  };
  const rest = pool
    .filter((n) => !placed.has(n.id))
    .map((nurse) => ({ nurse, ...standing(nurse.id) }))
    .sort((a, b) => {
      if (a.count !== b.count) return a.count - b.count;
      // Never floated, or longest ago, first.
      if (a.lastOn !== b.lastOn) {
        if (a.lastOn === undefined) return -1;
        if (b.lastOn === undefined) return 1;
        return compareDates(a.lastOn, b.lastOn);
      }
      // Most junior: the later seniority date, then the higher employee number.
      return compareSeniority(b.nurse, a.nurse);
    });
  for (const [i, e] of rest.entries()) {
    const next = rest[i + 1];
    const tiedWithNext = next !== undefined && next.count === e.count && next.lastOn === e.lastOn;
    const record =
      e.count === 0
        ? 'not floated in the last year'
        : `floated ${e.count} time${e.count === 1 ? '' : 's'} in the last year, last on ${describeDate(e.lastOn!)}`;
    order.push({
      nurseId: e.nurse.id,
      rank: order.length + 1,
      basis: 'rotation',
      reason: `Rotation: ${record}${tiedWithNext ? '; most junior' : ''}`,
    });
  }
  return { order, excluded };
}
