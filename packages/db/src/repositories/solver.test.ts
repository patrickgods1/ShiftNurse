/**
 * Repository tests for the unit's solver setting.
 *
 * What is easy to get quietly wrong here: a unit that never saved a choice must come back on the
 * default (hybrid), an unknown id must be refused rather than stored and silently fallen back
 * from at every solve, and a change must be audited with what it replaced.
 */

import { isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createUnit } from './config.js';
import { getSolverSettings, saveSolverSettings } from './solver.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;

beforeEach(() => {
  handle = openTestDatabase();
  unitId = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
});

afterEach(() => handle.close());

describe('solver settings', () => {
  it('gives a unit that never chose a solver the hybrid default', () => {
    expect(getSolverSettings(handle.db, unitId)).toEqual({ solverId: 'hybrid' });
  });

  it('remembers the solver the manager picked', () => {
    saveSolverSettings(handle.db, unitId, { solverId: 'sa-lns', maxIterations: 50_000 }, ACTOR);
    expect(getSolverSettings(handle.db, unitId)).toEqual({
      solverId: 'sa-lns',
      maxIterations: 50_000,
    });
  });

  it('audits a change with the choice it replaced', () => {
    const first = saveSolverSettings(handle.db, unitId, { solverId: 'sa-lns' }, ACTOR);
    saveSolverSettings(handle.db, unitId, { solverId: 'cp-sat' }, ACTOR);
    // Newest first.
    const history = auditHistoryFor(handle.db, 'solver_settings', first.id);
    expect(history.map((e) => e.action)).toEqual(['update', 'create']);
    expect(history[0]!.before).toEqual({ solverId: 'sa-lns' });
    expect(history[0]!.after).toEqual({ solverId: 'cp-sat' });
  });

  it('refuses a solver that does not exist', () => {
    expect(() =>
      saveSolverSettings(handle.db, unitId, { solverId: 'gurobi' as never }, ACTOR),
    ).toThrow(/unknown solver/i);
    expect(getSolverSettings(handle.db, unitId)).toEqual({ solverId: 'hybrid' });
  });

  it('refuses an iteration budget that is not a positive whole number', () => {
    expect(() =>
      saveSolverSettings(handle.db, unitId, { solverId: 'sa-lns', maxIterations: 0 }, ACTOR),
    ).toThrow(/iteration/i);
  });
});
