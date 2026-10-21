/**
 * The unit as a period is judged and priced with.
 *
 * Lived in the period loader; `holidays.ts` and `period-ledger.ts` need it too, and the period loader
 * imports them, so the import cycle made module init order fragile. This leaf imports only
 * `config.ts` and `pay-snapshot.ts`, so every caller reads the same attribution one way.
 */

import type { Id, SchedulePeriod, Unit } from '@shiftnurse/core';
import type { DbLike } from '../client.js';
import { getUnit } from './config.js';
import { type PayConfig, payConfigFor } from './pay-snapshot.js';

export function unitOrThrow(db: DbLike, unitId: Id) {
  const unit = getUnit(db, unitId);
  if (!unit) throw new Error(`Unknown unit ${unitId}`);
  return unit;
}

/** The live unit with the holiday attribution `config` was kept under; live when there is none. */
export function unitUnder(unit: Unit, config: PayConfig | undefined): Unit {
  if (!config) return unit;
  const { holidayAttribution: _live, ...rest } = unit;
  return config.holidayAttribution === undefined
    ? rest
    : { ...rest, holidayAttribution: config.holidayAttribution };
}

/**
 * The unit as a period is judged and priced with: a published or archived period keeps the
 * holiday attribution it went out under, so switching the unit to the clock reading does not
 * change what last Christmas's schedule paid or who it counted as working the holiday.
 */
export function unitForPeriod(db: DbLike, period: SchedulePeriod): Unit {
  return unitUnder(unitOrThrow(db, period.unitId), payConfigFor(db, period));
}
