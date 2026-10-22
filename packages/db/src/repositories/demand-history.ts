/**
 * The demand rules each unit had in force, as an effective-dated, append-only history.
 *
 * Ratio rules, acuity tiers, coverage floors, ratio staffing and which shift types are active are
 * edited in place. Read live, loosening a ratio from 1:5 to 1:6 today would make a published
 * schedule from March read as fully staffed on days it was in fact one nurse short, and retiring a
 * shift type would make its past demand vanish. A snapshot at publish time would be wrong the other
 * way: a ratio tightened by law in the middle of a period governs the dates left. So every change
 * records a version (`demand_config_version`, migration 0050), and a past date is judged by the
 * version in force when that day ended.
 *
 * The version is bookkeeping of the same change, like its audit row: every writer of those tables
 * (`acuity.ts`, `config.ts`, and through them the presets and seeds) calls
 * `recordDemandConfigVersion` right after its write and keeps its `DbLike` signature, since IPC
 * already runs each write in one `transact`. A writer that forgets is caught by the file itself:
 * triggers mark the unit in `demand_config_dirty`, the tripwire test fails, and the startup
 * backfill records what was missed.
 *
 * A step that writes many rows at once (a preset, a duplicate, a week of floors, a seed) runs in
 * `batchDemandVersions` and leaves one version, not one per row: a partial version (the first
 * shift type, no floors yet) is a set of rules the unit never had, and a date before the first
 * version is judged by the earliest one.
 *
 * Census and the HPPD target are not in a version: census is per-date data already, and the HPPD
 * target is advisory. Shift-type timing is not either; it is locked once a schedule used it.
 *
 * This module reads the tables itself rather than through `config.ts` or `acuity.ts`: those call
 * it, and importing them back would be a cycle.
 */

import {
  type AcuityTier,
  addDays,
  type CoverageRequirement,
  compareDates,
  type DemandInputs,
  DemandTable,
  datesInRange,
  deriveDemand,
  type Id,
  type IsoDate,
  type RatioRule,
  type RatioStaffing,
  type SchedulePeriod,
} from '@shiftnurse/core';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { localInstant, requireWholeMillis } from '../local-days.js';
import { toAcuityTier, toCoverageRequirement, toRatioRule } from '../mappers.js';
import {
  acuityTier,
  coverageRequirement,
  demandConfigDirty,
  demandConfigVersion,
  ratioRule,
  shiftType,
  unit,
} from '../schema.js';

/** What `deriveDemand` needs besides census, as the unit had it. */
export interface DemandConfig {
  /** Sorted. */
  activeShiftTypeIds: Id[];
  acuityTiers: AcuityTier[];
  /** Active rules only. */
  ratioRules: RatioRule[];
  coverageRequirements: CoverageRequirement[];
  ratioStaffing: RatioStaffing;
}

export interface DemandConfigVersion {
  id: Id;
  unitId: Id;
  /** 1, 2, 3… per unit, in the order recorded. */
  seq: number;
  /** Epoch millis: when the change was made, an event rather than schedule geometry. */
  effectiveAt: number;
  takenBy: string;
  reason?: string;
  config: DemandConfig;
}

const ENTITY = 'demand_config_version';

const MISSED_REASON = 'Recorded at startup: a change was saved without its version.';

const FIRST_REASON =
  'Recorded when ShiftNurse began keeping the demand rules each date is judged by; it holds the rules in force that day.';

const byId = <T extends { id: Id }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * One spelling per configuration: arrays by id and object keys sorted, so a row read back in
 * another order, or a mapper that lists its keys differently, never reads as a change.
 */
function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    ) as T;
  }
  return value;
}

function canonicalConfig(config: DemandConfig): DemandConfig {
  return canonical({
    activeShiftTypeIds: [...config.activeShiftTypeIds].sort(),
    acuityTiers: [...config.acuityTiers].sort(byId),
    ratioRules: [...config.ratioRules].sort(byId),
    coverageRequirements: [...config.coverageRequirements].sort(byId),
    ratioStaffing: config.ratioStaffing,
  });
}

/** The demand rules as the live tables hold them now, canonical. */
export function currentDemandConfig(db: DbLike, unitId: Id): DemandConfig {
  const row = db.select().from(unit).where(eq(unit.id, unitId)).get();
  if (!row) throw new Error(`Unit ${unitId} not found`);
  return canonicalConfig({
    activeShiftTypeIds: db
      .select({ id: shiftType.id })
      .from(shiftType)
      .where(and(eq(shiftType.unitId, unitId), eq(shiftType.active, true)))
      .all()
      .map((r) => r.id),
    acuityTiers: db
      .select()
      .from(acuityTier)
      .where(eq(acuityTier.unitId, unitId))
      .all()
      .map(toAcuityTier),
    ratioRules: db
      .select()
      .from(ratioRule)
      .where(and(eq(ratioRule.unitId, unitId), eq(ratioRule.active, true)))
      .all()
      .map(toRatioRule),
    coverageRequirements: db
      .select()
      .from(coverageRequirement)
      .where(eq(coverageRequirement.unitId, unitId))
      .all()
      .map(toCoverageRequirement),
    ratioStaffing: {
      chargeNurseTakesPatients: row.chargeNurseTakesPatients,
      breakMinutesPerNurse: row.breakMinutesPerNurse,
      chargeCoversBreaks: row.chargeCoversBreaks,
    },
  });
}

function toDemandConfig(raw: unknown, unitId: Id): DemandConfig {
  const value = raw as Partial<DemandConfig> | null;
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.activeShiftTypeIds) ||
    !Array.isArray(value.acuityTiers) ||
    !Array.isArray(value.ratioRules) ||
    !Array.isArray(value.coverageRequirements) ||
    typeof value.ratioStaffing !== 'object' ||
    value.ratioStaffing === null
  ) {
    // Judging a past date with "no ratio rules" would be a silently wrong verdict.
    throw new Error(`The demand rules kept for unit ${unitId} are damaged`);
  }
  return value as DemandConfig;
}

function toVersion(row: typeof demandConfigVersion.$inferSelect): DemandConfigVersion {
  return {
    id: row.id,
    unitId: row.unitId,
    seq: row.seq,
    effectiveAt: row.effectiveAt,
    takenBy: row.takenBy,
    ...(row.reason !== null && { reason: row.reason }),
    config: toDemandConfig(row.config, row.unitId),
  };
}

/** The unit's most recently recorded version: the highest `seq`. */
export function latestDemandConfigVersion(db: DbLike, unitId: Id): DemandConfigVersion | undefined {
  const row = db
    .select()
    .from(demandConfigVersion)
    .where(eq(demandConfigVersion.unitId, unitId))
    .orderBy(desc(demandConfigVersion.seq))
    .get();
  return row ? toVersion(row) : undefined;
}

interface PendingVersion {
  actor: string;
  reason?: string;
  at?: number;
}

// better-sqlite3 is synchronous, so a module-level scope cannot interleave with another caller.
let batchDepth = 0;
let pending = new Map<Id, PendingVersion>();

/**
 * Run `fn` with every `recordDemandConfigVersion` inside it held back, then record one version for
 * each unit it touched (none if a unit's rules came out unchanged). Nested batches join the
 * outermost. If `fn` throws, nothing is recorded: the caller's transaction is rolling back.
 */
export function batchDemandVersions<T>(db: DbLike, fn: () => T): T {
  batchDepth++;
  let result: T;
  try {
    result = fn();
  } catch (err) {
    batchDepth--;
    if (batchDepth === 0) pending = new Map();
    throw err;
  }
  batchDepth--;
  if (batchDepth > 0) return result;
  const units = pending;
  pending = new Map();
  for (const unitId of [...units.keys()].sort()) {
    const { actor, reason, at } = units.get(unitId)!;
    recordDemandConfigVersion(db, unitId, actor, {
      ...(reason !== undefined && { reason }),
      ...(at !== undefined && { at }),
    });
  }
  return result;
}

/**
 * Record the unit's live demand rules as a new version if they differ from the last one, and
 * clear the unit's dirty mark either way. Returns the new version, or `undefined` when nothing
 * changed or a `batchDemandVersions` scope will record it. `at` dates the version for tests and
 * imports; live paths never pass it.
 */
export function recordDemandConfigVersion(
  db: DbLike,
  unitId: Id,
  actor: string,
  options: { reason?: string; at?: number } = {},
): DemandConfigVersion | undefined {
  if (batchDepth > 0) {
    const held = pending.get(unitId);
    const reason = options.reason?.trim() || held?.reason;
    const at = options.at ?? held?.at;
    pending.set(unitId, {
      actor,
      ...(reason !== undefined && { reason }),
      ...(at !== undefined && { at }),
    });
    return undefined;
  }
  const config = currentDemandConfig(db, unitId);
  const previous = latestDemandConfigVersion(db, unitId);
  db.delete(demandConfigDirty).where(eq(demandConfigDirty.unitId, unitId)).run();
  if (previous && JSON.stringify(canonicalConfig(previous.config)) === JSON.stringify(config)) {
    return undefined;
  }
  if (options.at !== undefined) requireWholeMillis(options.at);
  const effectiveAt = options.at ?? Date.now();
  // Versions are read by `effective_at` and by `seq`; a back-dated one would make the two
  // disagree about which rules came last.
  if (previous && effectiveAt < previous.effectiveAt) {
    throw new Error(
      'A change to the demand rules cannot take effect before the change recorded before it.',
    );
  }
  const reason = options.reason?.trim() || undefined;
  const row = {
    id: ids.demandConfigVersion(),
    unitId,
    seq: (previous?.seq ?? 0) + 1,
    effectiveAt,
    takenBy: actor,
    reason: reason ?? null,
    config,
  };
  db.insert(demandConfigVersion).values(row).run();
  const version = toVersion(row);
  // No `before`: the previous version is itself kept, unchangeable, in the table.
  recordAudit(db, {
    entityType: ENTITY,
    entityId: unitId,
    action: 'create',
    actor,
    after: version,
    reason,
    at: effectiveAt,
  });
  return version;
}

/**
 * The version a past `date` is judged by: the one in force when the day ended, so a verdict never
 * changes as the day goes on. A date before the unit's first version (history seeded or imported
 * before versions were kept) reads the earliest one. `undefined` when the unit has none; the
 * caller then reads live. Whether a date is past at all is the caller's question.
 */
export function demandConfigOn(
  db: DbLike,
  unitId: Id,
  date: IsoDate,
): DemandConfigVersion | undefined {
  const endOfDay = localInstant(addDays(date, 1), '00:00');
  const inForce = db
    .select()
    .from(demandConfigVersion)
    .where(
      and(eq(demandConfigVersion.unitId, unitId), lt(demandConfigVersion.effectiveAt, endOfDay)),
    )
    .orderBy(desc(demandConfigVersion.effectiveAt), desc(demandConfigVersion.seq))
    .get();
  if (inForce) return toVersion(inForce);
  const earliest = db
    .select()
    .from(demandConfigVersion)
    .where(eq(demandConfigVersion.unitId, unitId))
    .orderBy(asc(demandConfigVersion.seq))
    .get();
  return earliest ? toVersion(earliest) : undefined;
}

/**
 * How a period's demand is judged. `live` is what `deriveDemand` reads from the tables now (the
 * caller loads it: this module cannot import the repositories that do). `today` absent — Generate,
 * the benchmark, the seeds — judges every date live, which is what a draft always gets.
 */
export interface DemandJudging {
  today?: IsoDate;
  live: DemandInputs;
}

// Units already reported this process: a judging read runs on every grid refresh, and one line
// in the log says as much as a thousand.
const reportedDirty = new Set<Id>();

/**
 * A change saved without its version means the newest rules have no version yet, so a date judged
 * now reads the version before them. That is still the best record there is, and refusing to judge
 * would blank the grid over bookkeeping; the startup backfill records the missing version. So say
 * it in the log, once per unit, and judge with what is kept.
 */
function reportIfDirty(db: DbLike, unitId: Id): void {
  if (reportedDirty.has(unitId)) return;
  const marked = db
    .select()
    .from(demandConfigDirty)
    .where(eq(demandConfigDirty.unitId, unitId))
    .get();
  if (!marked) return;
  reportedDirty.add(unitId);
  console.error(
    `[demand-history] Unit ${unitId} has a demand-rule change saved without its version; past dates are judged by the versions kept until the next start records it.`,
  );
}

/** The unit's versions, oldest first, read once for a whole period. */
function versionsOf(db: DbLike, unitId: Id): DemandConfigVersion[] {
  return db
    .select()
    .from(demandConfigVersion)
    .where(eq(demandConfigVersion.unitId, unitId))
    .orderBy(asc(demandConfigVersion.seq))
    .all()
    .map(toVersion);
}

/**
 * `demandConfigOn` over versions already read: the one in force when `date` ended, else the
 * earliest. `effective_at` never runs backwards against `seq` (`recordDemandConfigVersion`
 * refuses it), so the last one in `seq` order before the day's end is the one in force.
 */
function versionOn(versions: readonly DemandConfigVersion[], date: IsoDate) {
  const endOfDay = localInstant(addDays(date, 1), '00:00');
  let inForce: DemandConfigVersion | undefined;
  for (const v of versions) if (v.effectiveAt < endOfDay) inForce = v;
  return inForce ?? versions[0];
}

/**
 * The version that judges `date`, or `undefined` for live: only a past date of a published or
 * archived period has one. A day not yet over can still be changed by today's edits, and a draft
 * is a proposal under the rules it will be published into.
 */
function judgingVersion(
  versions: readonly DemandConfigVersion[],
  period: Pick<SchedulePeriod, 'status'>,
  date: IsoDate,
  today: IsoDate | undefined,
): DemandConfigVersion | undefined {
  if (period.status === 'draft' || today === undefined) return undefined;
  if (compareDates(date, today) >= 0) return undefined;
  return versionOn(versions, date);
}

/**
 * The live inputs with a version's rules in place. Census and the HPPD target stay live (they are
 * not in a version), and so do the shift-type rows, whose timing is locked once published; only
 * which of them were active comes from the version. A type deleted since cannot have a published
 * shift, so it is not missed.
 */
function inputsUnder(live: DemandInputs, config: DemandConfig): DemandInputs {
  const active = new Set(config.activeShiftTypeIds);
  return {
    ...live,
    shiftTypes: live.shiftTypes.map((t) =>
      t.active === active.has(t.id) ? t : { ...t, active: active.has(t.id) },
    ),
    acuityTiers: config.acuityTiers,
    ratioRules: config.ratioRules,
    coverageRequirements: config.coverageRequirements,
    ratioStaffing: config.ratioStaffing,
  };
}

/** What `deriveDemand` reads for one date of `period`: a version's rules, or the live ones. */
export function demandInputsForDate(
  db: DbLike,
  period: Pick<SchedulePeriod, 'unitId' | 'status'>,
  date: IsoDate,
  judging: DemandJudging,
): DemandInputs {
  if (period.status === 'draft' || judging.today === undefined) return judging.live;
  reportIfDirty(db, period.unitId);
  const version = judgingVersion(versionsOf(db, period.unitId), period, date, judging.today);
  return version ? inputsUnder(judging.live, version.config) : judging.live;
}

/**
 * The period's demand, each date derived under the rules that judge it. Dates run in order and
 * a run that shares a version is derived in one call. With every date live it is exactly one
 * `deriveDemand` over the period, so Generate and a draft read the same table as before versions
 * were kept.
 */
export function demandTableFor(
  db: DbLike,
  period: Pick<SchedulePeriod, 'unitId' | 'status' | 'startDate' | 'endDate'>,
  judging: DemandJudging,
): DemandTable {
  const dates = datesInRange(period.startDate, period.endDate);
  const judged = period.status !== 'draft' && judging.today !== undefined;
  if (judged) reportIfDirty(db, period.unitId);
  const versions = judged ? versionsOf(db, period.unitId) : [];
  // No version at all: live, as before versions were kept.
  if (versions.length === 0) return deriveDemand(dates, judging.live);
  const runs: { version: DemandConfigVersion | undefined; dates: IsoDate[] }[] = [];
  for (const date of dates) {
    const version = judgingVersion(versions, period, date, judging.today);
    const last = runs[runs.length - 1];
    if (last && last.version?.id === version?.id) last.dates.push(date);
    else runs.push({ version, dates: [date] });
  }
  if (runs.length === 1 && runs[0]!.version === undefined) {
    return deriveDemand(dates, judging.live);
  }
  return new DemandTable(
    runs.flatMap(({ version, dates: run }) =>
      deriveDemand(run, version ? inputsUnder(judging.live, version.config) : judging.live).all(),
    ),
  );
}

/**
 * Record what the writers missed: a version for every unit marked dirty, and a first version for
 * every unit with none (a file from before versions were kept, or a restored older backup).
 * Neither changes a verdict shown today, which is judged live until now. Marks left by a unit that
 * no longer exists are dropped. Returns how many versions were recorded.
 */
export function backfillDemandConfigVersions(tx: ShiftNurseTx, actor: string): number {
  const units = new Set(
    tx
      .select({ id: unit.id })
      .from(unit)
      .all()
      .map((r) => r.id),
  );
  const marked = new Set(
    tx
      .select()
      .from(demandConfigDirty)
      .all()
      .map((r) => r.unitId),
  );
  for (const id of marked) {
    if (!units.has(id)) tx.delete(demandConfigDirty).where(eq(demandConfigDirty.unitId, id)).run();
  }
  const kept = new Set(
    tx
      .selectDistinct({ unitId: demandConfigVersion.unitId })
      .from(demandConfigVersion)
      .all()
      .map((r) => r.unitId),
  );
  let recorded = 0;
  for (const id of [...units].sort()) {
    const reason = marked.has(id) ? MISSED_REASON : kept.has(id) ? undefined : FIRST_REASON;
    if (reason === undefined) continue;
    if (recordDemandConfigVersion(tx, id, actor, { reason })) recorded++;
  }
  return recorded;
}
