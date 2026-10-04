/**
 * Seniority leave bidding: a round of ranked requests for a season, awarded in seniority order.
 *
 * Most nursing contracts settle prime-time leave (summer weeks, school holidays) by bidding, not
 * first come first served: nurses rank the weeks they want, and the most senior nurse's choice is
 * honoured first. Doing it by hand is where grievances come from — a junior nurse awarded a week
 * a senior one ranked higher, or a denial nobody can explain. So the award is a pure function of
 * the bids, deterministic, and every choice not awarded carries the reason in words a manager can
 * quote: which days were full, and who holds them.
 *
 * The rule, as contracts usually write it: in seniority order (seniority date, then employee
 * number), each nurse is given their highest-ranked remaining choice whose every day still has a
 * free place for their role; one award a nurse a pass, and passes repeat until nobody gains a
 * week — so every nurse gets a first week before anyone gets a second. Leave already approved
 * takes its places first. Places are per role per day (`offPerDay`), set by the manager from what
 * the unit can spare (the leave capacity on the Requests page is the guide).
 */

import type { Id, Nurse, NurseRole, TimeOffRequest } from '../domain/entities.js';
import {
  addDays,
  compareDates,
  dateInRange,
  datesInRange,
  describeDate,
  describeDateRange,
  type IsoDate,
} from '../domain/time.js';

export interface LeaveBidRound {
  id: Id;
  unitId: Id;
  name: string;
  /** The season the round awards leave in; choices outside it are refused. */
  coversStart: IsoDate;
  coversEnd: IsoDate;
  /** Nurses of each role who may be off on any one day. A role not listed may not bid. */
  offPerDay: Partial<Record<NurseRole, number>>;
  /** The most choices one nurse may be awarded. Absent: no limit. */
  maxAwardsPerNurse?: number;
}

export interface LeaveBidChoice {
  /** 1 is the nurse's first choice. */
  rank: number;
  startDate: IsoDate;
  endDate: IsoDate;
}

export interface LeaveBid {
  id: Id;
  roundId: Id;
  nurseId: Id;
  choices: LeaveBidChoice[];
}

export interface LeaveAward {
  bidId: Id;
  nurseId: Id;
  rank: number;
  startDate: IsoDate;
  endDate: IsoDate;
  /** The pass it was won in: 1 is everyone's first week. */
  pass: number;
}

export interface LeaveDenial {
  bidId: Id;
  nurseId: Id;
  rank: number;
  startDate: IsoDate;
  endDate: IsoDate;
  pass: number;
  /** The days of the choice with no place left for the nurse's role. */
  fullDates: IsoDate[];
  /** Who holds those places: nurses awarded earlier, or on leave already approved. */
  heldBy: Id[];
  /** One sentence, quotable if the denial is grieved. */
  reason: string;
}

export interface BidResult {
  awards: LeaveAward[];
  denials: LeaveDenial[];
  /** Nurse ids in the order they were served. */
  order: Id[];
}

/** Most senior first: earliest seniority date, then the lower employee number. */
export function seniorityOrder(nurses: readonly Nurse[]): Nurse[] {
  return [...nurses].sort(
    (a, b) =>
      compareDates(a.seniorityDate, b.seniorityDate) ||
      a.employeeId.localeCompare(b.employeeId, undefined, { numeric: true }) ||
      a.id.localeCompare(b.id),
  );
}

const nameOf = (nurse: Nurse) => `${nurse.firstName} ${nurse.lastName}`;

/** One place off on one day, and how it was taken. */
interface Place {
  nurseId: Id;
  by: 'leave' | 'award';
}

/** "Mon Jul 5 to Fri Jul 9" or "Thu Jul 8", runs of consecutive days joined with commas. */
function describeDays(dates: readonly IsoDate[]): string {
  const runs: [IsoDate, IsoDate][] = [];
  for (const date of dates) {
    const last = runs[runs.length - 1];
    if (last && addDays(last[1], 1) === date) last[1] = date;
    else runs.push([date, date]);
  }
  return runs
    .map(([a, b]) => (a === b ? describeDate(a) : `${describeDate(a)} to ${describeDate(b)}`))
    .join(', ');
}

export function awardBids(
  round: LeaveBidRound,
  bids: readonly LeaveBid[],
  nurses: readonly Nurse[],
  approvedLeave: readonly TimeOffRequest[],
): BidResult {
  if (compareDates(round.coversStart, round.coversEnd) > 0) {
    throw new Error(`${round.name} ends before it starts`);
  }
  const byId = new Map(nurses.map((n) => [n.id, n]));
  const order = seniorityOrder(nurses.filter((n) => bids.some((b) => b.nurseId === n.id)));
  const rank = new Map(order.map((n, i) => [n.id, i]));

  // role → date → the places taken that day, and how: leave approved before the round, or an
  // award in it. Judged per day, since one nurse may hold a day by leave and another by award.
  const held = new Map<string, Place[]>();
  const key = (role: NurseRole, date: IsoDate) => `${role}|${date}`;
  const hold = (role: NurseRole, date: IsoDate, place: Place) => {
    const list = held.get(key(role, date)) ?? [];
    list.push(place);
    held.set(key(role, date), list);
  };
  for (const request of approvedLeave) {
    const nurse = byId.get(request.nurseId);
    if (!nurse || request.status !== 'approved') continue;
    for (const date of datesInRange(request.startDate, request.endDate)) {
      if (!dateInRange(date, round.coversStart, round.coversEnd)) continue;
      hold(nurse.role, date, { nurseId: nurse.id, by: 'leave' });
    }
  }

  const remaining = new Map(
    order.map((n) => {
      const choices = bids
        .filter((b) => b.nurseId === n.id)
        .flatMap((b) => b.choices.map((c) => ({ bidId: b.id, ...c })))
        .sort((a, b) => a.rank - b.rank);
      return [n.id, choices];
    }),
  );
  const won = new Map<Id, number>();
  const awards: LeaveAward[] = [];
  const denials: LeaveDenial[] = [];

  const deny = (
    nurse: Nurse,
    choice: { bidId: Id; rank: number; startDate: IsoDate; endDate: IsoDate },
    pass: number,
    why: string,
    fullDates: IsoDate[] = [],
    heldBy: Id[] = [],
  ) => {
    denials.push({
      bidId: choice.bidId,
      nurseId: nurse.id,
      rank: choice.rank,
      startDate: choice.startDate,
      endDate: choice.endDate,
      pass,
      fullDates,
      heldBy,
      reason: `Choice ${choice.rank} (${describeDateRange(choice.startDate, choice.endDate)}): ${why}.`,
    });
  };

  for (let pass = 1; ; pass++) {
    let awardedThisPass = false;
    for (const nurse of order) {
      const choices = remaining.get(nurse.id)!;
      const cap = round.maxAwardsPerNurse;
      while (choices.length > 0) {
        const choice = choices.shift()!;
        if (cap !== undefined && (won.get(nurse.id) ?? 0) >= cap) {
          deny(
            nurse,
            choice,
            pass,
            `${nameOf(nurse)} has already won the ${cap} choice${cap === 1 ? '' : 's'} the round allows`,
          );
          continue;
        }
        if (compareDates(choice.startDate, choice.endDate) > 0) {
          deny(nurse, choice, pass, 'it ends before it starts');
          continue;
        }
        if (
          !dateInRange(choice.startDate, round.coversStart, round.coversEnd) ||
          !dateInRange(choice.endDate, round.coversStart, round.coversEnd)
        ) {
          deny(
            nurse,
            choice,
            pass,
            `outside ${round.name} (${describeDateRange(round.coversStart, round.coversEnd)})`,
          );
          continue;
        }
        const places = round.offPerDay[nurse.role] ?? 0;
        if (places <= 0) {
          deny(nurse, choice, pass, `${round.name} has no places for ${nurse.role}s`);
          continue;
        }
        const days = datesInRange(choice.startDate, choice.endDate);
        const own = days.some((d) =>
          (held.get(key(nurse.role, d)) ?? []).some(
            (p) => p.nurseId === nurse.id && p.by === 'award',
          ),
        );
        if (own) {
          deny(nurse, choice, pass, `it overlaps a week ${nameOf(nurse)} has already won`);
          continue;
        }
        const full = days.filter((d) => (held.get(key(nurse.role, d))?.length ?? 0) >= places);
        if (full.length > 0) {
          const taken = full.flatMap((d) => held.get(key(nurse.role, d)) ?? []);
          // Bidders in service order, then nurses on leave only, each by id: the same text
          // however the bids and the leave were listed.
          const holders = [...new Set(taken.map((p) => p.nurseId))].sort(
            (a, b) =>
              (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
              a.localeCompare(b),
          );
          const names = holders.map((id) => {
            const ways = new Set(taken.filter((p) => p.nurseId === id).map((p) => p.by));
            const label =
              ways.size === 2
                ? ' (some days on leave already approved)'
                : ways.has('leave')
                  ? ' (leave already approved)'
                  : '';
            return `${nameOf(byId.get(id)!)}${label}`;
          });
          // "Senior to" only when every place on those days was won in the bidding by someone
          // served before this nurse; leave approved earlier is not seniority.
          const allSenior = taken.every(
            (p) => p.by === 'award' && (rank.get(p.nurseId) ?? -1) < rank.get(nurse.id)!,
          );
          const role = `${places} ${nurse.role}${places === 1 ? '' : 's'}`;
          deny(
            nurse,
            choice,
            pass,
            `${describeDays(full)} already ${full.length === 1 ? 'has' : 'have'} the ${role} off a day ` +
              `the round allows, taken by ${names.join(', ')}` +
              (allSenior ? `, senior to ${nameOf(nurse)}` : ''),
            full,
            holders,
          );
          continue;
        }
        for (const d of days) hold(nurse.role, d, { nurseId: nurse.id, by: 'award' });
        won.set(nurse.id, (won.get(nurse.id) ?? 0) + 1);
        awards.push({
          bidId: choice.bidId,
          nurseId: nurse.id,
          rank: choice.rank,
          startDate: choice.startDate,
          endDate: choice.endDate,
          pass,
        });
        awardedThisPass = true;
        break;
      }
    }
    if (!awardedThisPass) break;
  }

  return { awards, denials, order: order.map((n) => n.id) };
}
