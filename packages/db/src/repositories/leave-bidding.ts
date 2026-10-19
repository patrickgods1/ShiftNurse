/**
 * Seniority leave bidding: the rounds, the bids, and the award that turns bids into leave.
 *
 * The award is the part that must be all-or-nothing. It approves a request per award (lifting
 * the nurse off the draft grid exactly as a normal approval does), writes the reason for every
 * denial where it can be quoted, and closes the round — and a round half awarded would leave some
 * nurses holding leave the round's own count says they could not have. So `awardRound` takes
 * `ShiftNurseTx`, and a round can be awarded once: awarding twice would approve every week twice.
 *
 * The ranking and the reasons are core's (`awardBids`); this file loads the facts it judges by
 * and persists what it decides.
 */

import {
  type Assignment,
  awardBids,
  type BidResult,
  compareDates,
  daysBetween,
  describeDate,
  describeDateRange,
  type Id,
  type IsoDate,
  type LeaveAward,
  type LeaveBid,
  type LeaveBidChoice,
  type LeaveBidRound,
  type NurseRole,
  type RequestOrigin,
  suggestedPaidLeaveHours,
  type TimeOffRequest,
  typicalShiftHours,
} from '@shiftnurse/core';
import { asc, eq } from 'drizzle-orm';
import { recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import {
  leaveBid as bidTable,
  type LeaveBidRoundStatus,
  leaveBidRound as roundTable,
} from '../schema.js';
import { getUnit, listShiftTypesForUnit } from './config.js';
import { type PatchKeys, patchOf } from './patch.js';
import { getNurse, listNursesForUnit } from './roster.js';
import {
  approvedTimeOffInRange,
  approveTimeOffAndLiftAssignments,
  createTimeOffRequest,
} from './timeoff.js';

const ROUND = 'leave_bid_round';
const BID = 'leave_bid';

export type { LeaveBidRoundStatus };

/** A round as the manager manages it: core's judging fields plus the window and where it stands. */
export interface LeaveBidRoundRecord extends LeaveBidRound {
  opensOn: IsoDate;
  closesOn: IsoDate;
  status: LeaveBidRoundStatus;
  /** When the award ran; absent until it has. */
  awardedAt?: number;
}

/** A bid with the instant it was last entered. */
export interface LeaveBidRecord extends LeaveBid {
  submittedAt: number;
  /** 'manager' in v1; 'nurse' once self-service ships. Never inferred at read time. */
  enteredBy: RequestOrigin;
}

export type LeaveBidRoundInput = Omit<LeaveBidRoundRecord, 'id' | 'status' | 'awardedAt'>;

/** The unit never changes; `maxAwardsPerNurse: null` removes the limit. */
export interface LeaveBidRoundPatch {
  name?: string;
  coversStart?: IsoDate;
  coversEnd?: IsoDate;
  opensOn?: IsoDate;
  closesOn?: IsoDate;
  offPerDay?: Partial<Record<NurseRole, number>>;
  maxAwardsPerNurse?: number | null;
}

const PATCH_KEYS: PatchKeys<LeaveBidRoundPatch> = {
  name: true,
  coversStart: true,
  coversEnd: true,
  opensOn: true,
  closesOn: true,
  offPerDay: true,
  maxAwardsPerNurse: true,
};

export function listLeaveBidRounds(db: DbLike, unitId: Id): LeaveBidRoundRecord[] {
  return db
    .select()
    .from(roundTable)
    .where(eq(roundTable.unitId, unitId))
    .orderBy(asc(roundTable.coversStart), asc(roundTable.id))
    .all()
    .map(toRound);
}

export function getLeaveBidRound(db: DbLike, id: Id): LeaveBidRoundRecord | undefined {
  const row = db.select().from(roundTable).where(eq(roundTable.id, id)).get();
  return row ? toRound(row) : undefined;
}

export function listLeaveBids(db: DbLike, roundId: Id): LeaveBidRecord[] {
  return db
    .select()
    .from(bidTable)
    .where(eq(bidTable.roundId, roundId))
    .orderBy(asc(bidTable.submittedAt), asc(bidTable.id))
    .all()
    .map(toBid);
}

export function createLeaveBidRound(
  db: DbLike,
  input: LeaveBidRoundInput,
  actor: string,
): LeaveBidRoundRecord {
  const round: LeaveBidRoundRecord = {
    id: ids.leaveBidRound(),
    unitId: input.unitId,
    name: input.name.trim(),
    coversStart: input.coversStart,
    coversEnd: input.coversEnd,
    opensOn: input.opensOn,
    closesOn: input.closesOn,
    offPerDay: cleanPlaces(input.offPerDay),
    ...(input.maxAwardsPerNurse !== undefined
      ? { maxAwardsPerNurse: input.maxAwardsPerNurse }
      : {}),
    status: 'open',
  };
  validateRound(round);
  db.insert(roundTable).values(toRow(round)).run();
  recordAudit(db, { entityType: ROUND, entityId: round.id, action: 'create', actor, after: round });
  return round;
}

export function updateLeaveBidRound(
  db: DbLike,
  id: Id,
  patch: LeaveBidRoundPatch,
  actor: string,
  reason?: string,
): LeaveBidRoundRecord {
  const before = requireRound(db, id);
  if (before.status === 'awarded') {
    throw new Error(`${before.name} has been awarded; its places and dates can no longer change`);
  }
  const changes = patchOf(patch, PATCH_KEYS, 'bidding round');
  const after: LeaveBidRoundRecord = { ...before };
  if (changes.name !== undefined) after.name = changes.name.trim();
  if (changes.coversStart !== undefined) after.coversStart = changes.coversStart;
  if (changes.coversEnd !== undefined) after.coversEnd = changes.coversEnd;
  if (changes.opensOn !== undefined) after.opensOn = changes.opensOn;
  if (changes.closesOn !== undefined) after.closesOn = changes.closesOn;
  // Replaces the whole map, not role by role: a caller sends every role it means to keep.
  if (changes.offPerDay !== undefined) after.offPerDay = cleanPlaces(changes.offPerDay);
  if (changes.maxAwardsPerNurse === null) delete after.maxAwardsPerNurse;
  else if (changes.maxAwardsPerNurse !== undefined) {
    after.maxAwardsPerNurse = changes.maxAwardsPerNurse;
  }
  validateRound(after);

  // Once bidders have relied on the dates and places, changing them is a decision someone may
  // ask about; and a season that no longer holds a bid's choice would only fail at the award.
  const bids = listLeaveBids(db, id);
  const judged = bids.length > 0 && judgedFieldsChanged(before, after);
  if (bids.length > 0) {
    assertNoStrandedChoice(db, after, bids);
    if (judged && !reason?.trim()) {
      throw new Error(
        `Bids are already in for ${before.name}; say why its dates or places are changing.`,
      );
    }
  }
  db.update(roundTable).set(toRow(after)).where(eq(roundTable.id, id)).run();
  const entry = {
    entityType: ROUND,
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  } as const;
  if (judged) recordAuditStrict(db, { ...entry, reason }, { requireReason: true });
  else recordAudit(db, { ...entry, ...(reason?.trim() ? { reason } : {}) });
  return after;
}

/**
 * Stop taking bids; only a closed round can be awarded. `closedOn` is passed in (never read from
 * a clock here). Closing on or before the last bidding day shuts out nurses who have not bid yet,
 * so it needs a recorded reason.
 */
export function closeLeaveBidRound(
  db: DbLike,
  id: Id,
  actor: string,
  closedOn: IsoDate,
  reason?: string,
): LeaveBidRoundRecord {
  const before = requireRound(db, id);
  if (before.status !== 'open') throw new Error(`${before.name} is already ${before.status}`);
  const early = compareDates(closedOn, before.closesOn) <= 0;
  if (early && !reason?.trim()) {
    throw new Error(
      `Bidding for ${before.name} runs until ${describeDate(before.closesOn)}. Closing it now shuts out anyone who has not bid yet, so give a reason.`,
    );
  }
  const after: LeaveBidRoundRecord = { ...before, status: 'closed' };
  db.update(roundTable).set({ status: 'closed' }).where(eq(roundTable.id, id)).run();
  const entry = {
    entityType: ROUND,
    entityId: id,
    action: 'update',
    actor,
    before,
    after,
  } as const;
  if (early) recordAuditStrict(db, { ...entry, reason }, { requireReason: true });
  else recordAudit(db, { ...entry, ...(reason?.trim() ? { reason } : {}) });
  return after;
}

/**
 * Enter a nurse's bid, or replace the one they have: a nurse changing their mind is the same
 * sheet again, not a second bid that would win them twice. `enteredBy` is stored: v1 is the
 * manager transcribing, and self-service will say `'nurse'` here.
 */
export function submitLeaveBid(
  db: DbLike,
  roundId: Id,
  nurseId: Id,
  choices: readonly LeaveBidChoice[],
  actor: string,
  enteredOn: IsoDate,
  enteredBy: RequestOrigin = 'manager',
): LeaveBidRecord {
  const round = requireRound(db, roundId);
  if (round.status !== 'open') {
    throw new Error(`${round.name} is ${round.status}; it no longer takes bids`);
  }
  if (compareDates(enteredOn, round.opensOn) < 0) {
    throw new Error(
      `Bidding for ${round.name} opens on ${describeDate(round.opensOn)}; a bid cannot be entered before then.`,
    );
  }
  if (compareDates(enteredOn, round.closesOn) > 0) {
    throw new Error(
      `Bidding for ${round.name} closed on ${describeDate(round.closesOn)}; a late bid cannot be entered.`,
    );
  }
  const nurse = getNurse(db, nurseId);
  if (!nurse || nurse.unitId !== round.unitId) throw new Error('That nurse is not on this unit');
  if (!nurse.active) throw new Error(`${nurse.firstName} ${nurse.lastName} is not active`);
  const sorted = checkChoices(round, choices);

  const existing = listLeaveBids(db, roundId).find((b) => b.nurseId === nurseId);
  const bid: LeaveBidRecord = {
    id: existing?.id ?? ids.leaveBid(),
    roundId,
    nurseId,
    choices: sorted,
    submittedAt: Date.now(),
    enteredBy,
  };
  if (existing) {
    db.update(bidTable)
      .set({ choices: bid.choices, submittedAt: bid.submittedAt, enteredBy })
      .where(eq(bidTable.id, bid.id))
      .run();
  } else {
    db.insert(bidTable).values(bid).run();
  }
  recordAudit(db, {
    entityType: BID,
    entityId: bid.id,
    action: existing ? 'update' : 'create',
    actor,
    ...(existing ? { before: existing } : {}),
    after: bid,
  });
  return bid;
}

export interface AwardedLeave {
  award: LeaveAward;
  /** The approved PTO request the award became. */
  request: TimeOffRequest;
  /** Draft shifts the approval took off the grid. */
  lifted: Assignment[];
  /** Shifts on a published period, left in place and now a conflict for the manager. */
  stillRostered: Assignment[];
}

export interface AwardRoundResult {
  round: LeaveBidRoundRecord;
  result: BidResult;
  awarded: AwardedLeave[];
}

/**
 * Run the award and write it. Each award becomes an approved PTO request through
 * `approveTimeOffAndLiftAssignments`, so a draft shift on an awarded day comes off the grid just
 * as if the manager had approved the request by hand. Each denial is audited against its bid with
 * core's sentence as the reason — that sentence is what the manager quotes to the nurse.
 */
export function awardRound(tx: ShiftNurseTx, roundId: Id, actor: string): AwardRoundResult {
  const before = requireRound(tx, roundId);
  if (before.status === 'awarded') throw new Error(`${before.name} has already been awarded`);
  if (before.status !== 'closed')
    throw new Error(`Close bidding for ${before.name} before awarding it.`);
  const bids = listLeaveBids(tx, roundId);
  if (bids.length === 0) throw new Error(`Nobody has bid in ${before.name} yet`);

  // Core judges every bidder, so one who has since moved unit is passed too and denied in words.
  const nurses = listNursesForUnit(tx, before.unitId);
  for (const bid of bids) {
    if (nurses.some((n) => n.id === bid.nurseId)) continue;
    const moved = getNurse(tx, bid.nurseId);
    if (moved) nurses.push(moved);
  }
  const result = awardBids(
    before,
    bids,
    nurses,
    approvedTimeOffInRange(tx, before.unitId, before.coversStart, before.coversEnd),
  );

  // Awarded PTO pays the shifts the nurse would have worked, as the request dialog suggests;
  // without paid hours every winner would read as short of contract for the weeks they won.
  const unit = getUnit(tx, before.unitId)!;
  const shiftHours = typicalShiftHours(listShiftTypesForUnit(tx, before.unitId));
  const awarded: AwardedLeave[] = result.awards.map((award) => {
    const reason =
      `Awarded in ${before.name}: choice ${award.rank}` +
      (award.alreadyOnLeave.length > 0
        ? `; ${award.alreadyOnLeave.length} day(s) already on approved leave, not paid again`
        : '');
    const nurse = nurses.find((n) => n.id === award.nurseId)!;
    // A day already on approved leave was paid with that leave; paying it again doubles it.
    const unpaidDays =
      daysBetween(award.startDate, award.endDate) + 1 - award.alreadyOnLeave.length;
    const paidHours =
      unpaidDays > 0
        ? suggestedPaidLeaveHours({
            type: 'pto',
            days: unpaidDays,
            contractedHoursPerPeriod: nurse.contractedHoursPerPeriod,
            payPeriodDays: unit.payPeriodDays,
            shiftHours,
          })
        : 0;
    const request = createTimeOffRequest(
      tx,
      {
        nurseId: award.nurseId,
        startDate: award.startDate,
        endDate: award.endDate,
        type: 'pto',
        reason,
        ...(paidHours > 0 ? { paidHours } : {}),
      },
      actor,
    );
    const approved = approveTimeOffAndLiftAssignments(tx, request.id, actor, reason);
    return {
      award,
      request: approved.request,
      lifted: approved.lifted,
      stillRostered: approved.stillRostered,
    };
  });

  for (const denial of result.denials) {
    const { reason, ...detail } = denial;
    recordAuditStrict(tx, {
      entityType: BID,
      entityId: denial.bidId,
      action: 'deny',
      actor,
      after: detail,
      reason,
    });
  }

  const awardedAt = Date.now();
  tx.update(roundTable)
    .set({ status: 'awarded', awardedAt })
    .where(eq(roundTable.id, roundId))
    .run();
  const round: LeaveBidRoundRecord = { ...before, status: 'awarded', awardedAt };
  recordAudit(tx, {
    entityType: ROUND,
    entityId: roundId,
    action: 'update',
    actor,
    before,
    after: round,
    reason: `Awarded in seniority order: ${result.awards.length} won, ${result.denials.length} denied`,
  });
  return { round, result, awarded };
}

function judgedFieldsChanged(a: LeaveBidRoundRecord, b: LeaveBidRoundRecord): boolean {
  const places = (r: LeaveBidRoundRecord) =>
    JSON.stringify(Object.entries(r.offPerDay).sort(([x], [y]) => x.localeCompare(y)));
  return (
    a.coversStart !== b.coversStart ||
    a.coversEnd !== b.coversEnd ||
    a.opensOn !== b.opensOn ||
    a.closesOn !== b.closesOn ||
    a.maxAwardsPerNurse !== b.maxAwardsPerNurse ||
    places(a) !== places(b)
  );
}

/** First offending bid by entry time, then choice rank, so the message is stable. */
function assertNoStrandedChoice(
  db: DbLike,
  round: LeaveBidRoundRecord,
  bids: readonly LeaveBidRecord[],
): void {
  for (const bid of bids) {
    for (const choice of bid.choices) {
      if (
        compareDates(choice.startDate, round.coversStart) >= 0 &&
        compareDates(choice.endDate, round.coversEnd) <= 0
      ) {
        continue;
      }
      const nurse = getNurse(db, bid.nurseId);
      const who = nurse ? `${nurse.firstName} ${nurse.lastName}` : 'a nurse';
      throw new Error(
        `Choice ${choice.rank} of ${who}'s bid (${describeDateRange(choice.startDate, choice.endDate)}) falls outside the new dates. Change the bid first, or keep the season as it is.`,
      );
    }
  }
}

function requireRound(db: DbLike, id: Id): LeaveBidRoundRecord {
  const round = getLeaveBidRound(db, id);
  if (!round) throw new Error('That bidding round no longer exists');
  return round;
}

/** Places are people: whole numbers, zero or more. Zero is kept, as "this role may not bid". */
function cleanPlaces(
  places: Partial<Record<NurseRole, number>>,
): Partial<Record<NurseRole, number>> {
  const out: Partial<Record<NurseRole, number>> = {};
  for (const [role, count] of Object.entries(places) as [NurseRole, number | undefined][]) {
    if (count === undefined) continue;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Places off a day for ${role}s must be a whole number, zero or more`);
    }
    out[role] = count;
  }
  return out;
}

function validateRound(round: LeaveBidRoundRecord): void {
  if (!round.name) throw new Error('A bidding round needs a name');
  if (compareDates(round.coversStart, round.coversEnd) > 0) {
    throw new Error(`${round.name} ends before it starts`);
  }
  if (!Object.values(round.offPerDay).some((n) => n > 0)) {
    throw new Error('A round needs at least one place off a day for some role');
  }
  if (compareDates(round.opensOn, round.closesOn) > 0) {
    throw new Error(`Bidding for ${round.name} closes before it opens`);
  }
  if (
    round.maxAwardsPerNurse !== undefined &&
    (!Number.isInteger(round.maxAwardsPerNurse) || round.maxAwardsPerNurse < 1)
  ) {
    throw new Error('The most weeks one nurse can win must be a whole number, 1 or more');
  }
}

/**
 * Ranks must be 1..n with none missing or repeated, so "second choice" always means the same
 * thing; a choice outside the season is refused here, in words, rather than denied later.
 * Returned in rank order.
 */
function checkChoices(
  round: LeaveBidRoundRecord,
  choices: readonly LeaveBidChoice[],
): LeaveBidChoice[] {
  if (choices.length === 0) throw new Error('A bid needs at least one choice');
  const sorted = [...choices].sort((a, b) => a.rank - b.rank);
  sorted.forEach((choice, i) => {
    if (choice.rank !== i + 1) {
      throw new Error('Choices must be ranked 1, 2, 3… with none missing or repeated');
    }
    if (compareDates(choice.startDate, choice.endDate) > 0) {
      throw new Error(`Choice ${choice.rank} ends before it starts`);
    }
    if (
      compareDates(choice.startDate, round.coversStart) < 0 ||
      compareDates(choice.endDate, round.coversEnd) > 0
    ) {
      throw new Error(
        `Choice ${choice.rank} is outside ${round.name}, which covers ${round.coversStart} to ${round.coversEnd}`,
      );
    }
  });
  return sorted.map(({ rank, startDate, endDate }) => ({ rank, startDate, endDate }));
}

function toRow(round: LeaveBidRoundRecord): typeof roundTable.$inferInsert {
  return {
    id: round.id,
    unitId: round.unitId,
    name: round.name,
    coversStart: round.coversStart,
    coversEnd: round.coversEnd,
    opensOn: round.opensOn,
    closesOn: round.closesOn,
    offPerDay: round.offPerDay,
    maxAwardsPerNurse: round.maxAwardsPerNurse ?? null,
    status: round.status,
    awardedAt: round.awardedAt ?? null,
  };
}

function toRound(row: typeof roundTable.$inferSelect): LeaveBidRoundRecord {
  return {
    id: row.id,
    unitId: row.unitId,
    name: row.name,
    coversStart: row.coversStart,
    coversEnd: row.coversEnd,
    opensOn: row.opensOn,
    closesOn: row.closesOn,
    offPerDay: row.offPerDay,
    ...(row.maxAwardsPerNurse !== null ? { maxAwardsPerNurse: row.maxAwardsPerNurse } : {}),
    status: row.status,
    ...(row.awardedAt !== null ? { awardedAt: row.awardedAt } : {}),
  };
}

function toBid(row: typeof bidTable.$inferSelect): LeaveBidRecord {
  return {
    id: row.id,
    roundId: row.roundId,
    nurseId: row.nurseId,
    choices: row.choices,
    submittedAt: row.submittedAt,
    enteredBy: row.enteredBy,
  };
}
