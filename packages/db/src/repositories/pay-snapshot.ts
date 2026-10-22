/**
 * The pay configuration each published period was priced under.
 *
 * Differentials and overtime rules have no dates, pay settings are one row per unit, and the
 * unit's holiday attribution is a column on the unit: all of them are edited in place. Read live,
 * a November raise to the night differential would make October's cost report say October cost
 * more than staff were paid for it. So the first publication of a period takes a snapshot of
 * that configuration (`pay_config_snapshot`), and from then on the period is priced from it;
 * only `repricePeriod`, with a strict reason, takes a newer one. It is the same promise the
 * period's pinned rule-set version makes for the rules. Drafts are always priced live.
 *
 * Pay rates are not in it: they carry `effectiveFrom` already, and correcting a wrong rate in
 * place is a correction, not a change of contract.
 */

import type {
  Differential,
  HolidayAttribution,
  Id,
  IsoDate,
  OvertimeRule,
  PaySettings,
  SchedulePeriod,
} from '@shiftnurse/core';
import { DEFAULT_PAY_SETTINGS } from '@shiftnurse/core';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { type AuditInput, recordAudit, recordAuditStrict } from '../audit.js';
import type { DbLike, ShiftNurseTx } from '../client.js';
import { ids } from '../ids.js';
import { payConfigSnapshot, schedulePeriod } from '../schema.js';
import { getUnit, listHolidaysInRange } from './config.js';
import { getPaySettings, listActiveDifferentials, listActiveOvertimeRules } from './pay.js';
import { getPeriod } from './schedule.js';
import { timeOffWindow } from './solve-input.js';

export interface PayConfig {
  /** Active differentials when taken. */
  differentials: Differential[];
  /** Active overtime rules when taken. */
  overtimeRules: OvertimeRule[];
  /** `getPaySettings` as it read then (defaults when the unit had saved none). */
  paySettings: PaySettings;
  /** The unit's holiday attribution then; absent reads 'start' (D18). */
  holidayAttribution?: HolidayAttribution;
  /** The unit's holidays inside `timeOffWindow(unit, period)` then. */
  holidays: { date: IsoDate; isMajor: boolean }[];
}

export interface PayConfigSnapshot {
  id: Id;
  periodId: Id;
  seq: number;
  /** Epoch millis: when it was taken, an event rather than schedule geometry. */
  takenAt: number;
  takenBy: string;
  reason?: string;
  config: PayConfig;
}

const ENTITY = 'pay_config_snapshot';

const BACKFILL_REASON =
  'Taken when ShiftNurse began keeping the pay settings each published schedule was priced under; it holds the settings in force that day.';

/** The pay configuration as the live tables hold it now, for this period's unit and dates. */
export function currentPayConfig(db: DbLike, period: SchedulePeriod): PayConfig {
  const unit = getUnit(db, period.unitId);
  if (!unit) throw new Error(`Unit ${period.unitId} not found`);
  // The same window cost reads leave over, so every holiday the period's pricing can touch
  // (the lookback tail's weeks included) is kept, and far-off ones are not.
  const { start, end } = timeOffWindow(unit, period);
  const holidays = listHolidaysInRange(db, unit.id, start, end)
    .map((h) => ({ date: h.date, isMajor: h.isMajor }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    differentials: listActiveDifferentials(db, unit.id),
    overtimeRules: listActiveOvertimeRules(db, unit.id),
    paySettings: getPaySettings(db, unit.id),
    ...(unit.holidayAttribution !== undefined && { holidayAttribution: unit.holidayAttribution }),
    holidays,
  };
}

function toPayConfig(raw: unknown, periodId: Id): PayConfig {
  const value = raw as Partial<PayConfig> | null;
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray(value.differentials) ||
    !Array.isArray(value.overtimeRules) ||
    !Array.isArray(value.holidays) ||
    typeof value.paySettings !== 'object' ||
    value.paySettings === null
  ) {
    // A damaged snapshot priced as "no differentials" would be a silently wrong number.
    throw new Error(`The pay settings kept for schedule period ${periodId} are damaged`);
  }
  return {
    differentials: value.differentials,
    overtimeRules: value.overtimeRules,
    // Any field added to PaySettings later must decide how a snapshot taken without it reads:
    // the behaviour before the field existed, which is not necessarily today's default. Override
    // it here when the two differ. (`paySpringForwardAsScheduled` and `breakPremiumRate`: their
    // defaults, false and 'base', are how a period was priced before migration 0051.)
    paySettings: { ...DEFAULT_PAY_SETTINGS, ...value.paySettings },
    ...(value.holidayAttribution !== undefined && {
      holidayAttribution: value.holidayAttribution,
    }),
    holidays: value.holidays,
  };
}

function toSnapshot(row: typeof payConfigSnapshot.$inferSelect): PayConfigSnapshot {
  return {
    id: row.id,
    periodId: row.periodId,
    seq: row.seq,
    takenAt: row.takenAt,
    takenBy: row.takenBy,
    ...(row.reason !== null && { reason: row.reason }),
    config: toPayConfig(row.config, row.periodId),
  };
}

/** The snapshot the period is priced under now: the highest `seq`. */
export function latestPayConfigSnapshot(db: DbLike, periodId: Id): PayConfigSnapshot | undefined {
  const row = db
    .select()
    .from(payConfigSnapshot)
    .where(eq(payConfigSnapshot.periodId, periodId))
    .orderBy(desc(payConfigSnapshot.seq))
    .get();
  return row ? toSnapshot(row) : undefined;
}

/**
 * The kept configuration a period is priced from, or `undefined` to price it live: always for a
 * draft, and for a published period that somehow has none (the startup backfill closes that).
 */
export function payConfigFor(db: DbLike, period: SchedulePeriod): PayConfig | undefined {
  if (period.status === 'draft') return undefined;
  return latestPayConfigSnapshot(db, period.id)?.config;
}

function insertSnapshot(
  db: DbLike,
  period: SchedulePeriod,
  actor: string,
  reason: string | undefined,
  strict: boolean,
): PayConfigSnapshot {
  const previous = latestPayConfigSnapshot(db, period.id);
  const takenAt = Date.now();
  const row = {
    id: ids.payConfigSnapshot(),
    periodId: period.id,
    seq: (previous?.seq ?? 0) + 1,
    takenAt,
    takenBy: actor,
    reason: reason ?? null,
    config: currentPayConfig(db, period),
  };
  db.insert(payConfigSnapshot).values(row).run();
  const snapshot = toSnapshot(row);
  const audit: AuditInput = {
    entityType: ENTITY,
    entityId: period.id,
    action: 'create',
    actor,
    before: previous?.config,
    after: snapshot,
    reason,
    at: takenAt,
  };
  if (strict) recordAuditStrict(db, audit, { requireReason: true });
  else recordAudit(db, audit);
  return snapshot;
}

/** Keep the live pay configuration as the one this period is priced under from now on. */
export function takePayConfigSnapshot(
  db: DbLike,
  period: SchedulePeriod,
  actor: string,
  reason?: string,
): PayConfigSnapshot {
  return insertSnapshot(db, period, actor, reason?.trim() || undefined, false);
}

/**
 * "Reprice with today's pay settings": a retroactive contract change. Staff were paid under the
 * kept settings, so this needs a strict reason; the audit row keeps the old configuration as
 * `before`. A draft has nothing to reprice and an archived period is the closed pay record.
 */
export function repricePeriod(
  // A transaction: the snapshot and its strict audit row are only correct together.
  tx: ShiftNurseTx,
  periodId: Id,
  actor: string,
  reason: string,
): PayConfigSnapshot {
  const period = getPeriod(tx, periodId);
  if (!period) throw new Error(`Schedule period ${periodId} not found`);
  if (period.status === 'draft') {
    throw new Error(
      `"${period.name}" is a draft; a draft is always priced with today’s pay settings.`,
    );
  }
  if (period.status === 'archived') {
    throw new Error(`"${period.name}" is archived; its pay record cannot be changed.`);
  }
  // Checked before any write, in words a manager reads; the strict audit backstops it.
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error(
      `Repricing "${period.name}" needs a reason: staff were paid under the settings it was published with.`,
    );
  }
  return insertSnapshot(tx, period, actor, trimmed, true);
}

/**
 * Snapshot every published or archived period that has none: those published before snapshots
 * were kept, or a restored older backup. They are priced live today, so taking today's settings
 * changes no number shown; it only stops later edits from repricing them. Returns how many.
 */
export function backfillPayConfigSnapshots(tx: ShiftNurseTx, actor: string): number {
  const kept = new Set(
    tx
      .selectDistinct({ periodId: payConfigSnapshot.periodId })
      .from(payConfigSnapshot)
      .all()
      .map((r) => r.periodId),
  );
  const missing = tx
    .select({ id: schedulePeriod.id })
    .from(schedulePeriod)
    .where(inArray(schedulePeriod.status, ['published', 'archived']))
    .orderBy(asc(schedulePeriod.startDate), asc(schedulePeriod.id))
    .all()
    .filter((r) => !kept.has(r.id));
  for (const { id } of missing) {
    insertSnapshot(tx, getPeriod(tx, id)!, actor, BACKFILL_REASON, false);
  }
  return missing.length;
}
