/**
 * The unit's solver setting (M15): which backend Generate uses by default.
 *
 * Validated here as well as in the renderer because a stored unknown id would not fail loudly —
 * every solve would quietly fall back to another backend and the manager would never learn their
 * choice was not being honoured.
 */

import {
  DEFAULT_SOLVER_SETTINGS,
  type Id,
  isSolverId,
  type SolverSettings,
} from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit.js';
import type { DbLike } from '../client.js';
import { ids } from '../ids.js';
import { solverSettings } from '../schema.js';

function toSettings(row: typeof solverSettings.$inferSelect): SolverSettings {
  return row.maxIterations === null
    ? { solverId: row.solverId }
    : { solverId: row.solverId, maxIterations: row.maxIterations };
}

/** A unit with no saved choice gets the default (hybrid). */
export function getSolverSettings(db: DbLike, unitId: Id): SolverSettings {
  const row = db.select().from(solverSettings).where(eq(solverSettings.unitId, unitId)).get();
  return row ? toSettings(row) : { ...DEFAULT_SOLVER_SETTINGS };
}

export function saveSolverSettings(
  db: DbLike,
  unitId: Id,
  settings: SolverSettings,
  actor: string,
): SolverSettings & { id: Id } {
  if (!isSolverId(settings.solverId)) {
    throw new Error(`Unknown solver "${String(settings.solverId)}"`);
  }
  const max = settings.maxIterations;
  if (max !== undefined && !(Number.isInteger(max) && max > 0)) {
    throw new Error('The iteration budget must be a positive whole number');
  }
  const values = { solverId: settings.solverId, maxIterations: max ?? null };
  const row = db.select().from(solverSettings).where(eq(solverSettings.unitId, unitId)).get();
  if (row) {
    const before = toSettings(row);
    db.update(solverSettings).set(values).where(eq(solverSettings.id, row.id)).run();
    const after = toSettings({ ...row, ...values });
    recordAudit(db, {
      entityType: 'solver_settings',
      entityId: row.id,
      action: 'update',
      actor,
      before,
      after,
    });
    return { id: row.id, ...after };
  }
  const id = ids.solverSettings();
  db.insert(solverSettings)
    .values({ id, unitId, ...values })
    .run();
  const after = toSettings({ id, unitId, ...values });
  recordAudit(db, { entityType: 'solver_settings', entityId: id, action: 'create', actor, after });
  return { id, ...after };
}
