/**
 * A seeded demo unit in an in-memory database, for testing the `api/` modules under plain Node.
 * The draft period starts empty; tests place the shifts they need through the same API handlers
 * the renderer calls, so what they exercise is the IPC behaviour, not a repository shortcut.
 */

import { isoDate, type Nurse, type ShiftType } from '@shiftnurse/core';
import {
  listNursesForUnit,
  listShiftTypesForUnit,
  type OpenedDatabase,
  openTestDatabase,
  type SeedResult,
  seedDemoUnit,
  transact,
} from '@shiftnurse/db';

export interface Fixture {
  handle: OpenedDatabase;
  seeded: SeedResult;
  /** Active RNs, sorted by id so tests pick the same nurses every run. */
  rns: Nurse[];
  day: ShiftType;
}

export function openFixture(): Fixture {
  const handle = openTestDatabase();
  const seeded = transact(handle.db, (tx) =>
    seedDemoUnit(tx, { seed: 7, today: isoDate('2026-09-17'), historyPeriods: 2 }),
  );
  const rns = listNursesForUnit(handle.db, seeded.unitId)
    .filter((n) => n.active && n.role === 'RN')
    .sort((a, b) => a.id.localeCompare(b.id));
  const day = listShiftTypesForUnit(handle.db, seeded.unitId).find(
    (s) => s.active && !s.isNight && !s.isOnCall && s.durationHours === 12,
  );
  if (!day) throw new Error('demo unit has no 12-hour day shift');
  return { handle, seeded, rns, day };
}
