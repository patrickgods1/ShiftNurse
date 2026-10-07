/**
 * First-run setup over IPC: which screen a launch opens, the demo / manual / assisted starts,
 * the guide's step moves and its one-click presets.
 *
 * Runs under plain Node (tested that way); the one Electron-bound step, Start over, deletes the
 * database file and relaunches, so it lives in `backups.ts` beside restore and is passed in.
 *
 * The test-scenario database is offered only when `scenariosAvailable` — in `npm run dev`, never
 * in an installed app, where a manager must not be able to fill their real database with
 * planted problems.
 */

import { setupPhase } from '@shiftnurse/core';
import {
  advanceSetup,
  applyJurisdiction,
  applySetupPreset,
  completeSetup,
  createSetupUnit,
  DEMO_SUMMARIES,
  getSetupState,
  isDemoId,
  listUnits,
  loadDemo,
  loadScenarios,
  type ShiftNurseDb,
  startSetup,
  transact,
} from '@shiftnurse/db';
import type { BackupInfo, ShiftNurseApi } from '../../shared/api.js';
import { ACTOR } from './context.js';

export interface SetupApiOptions {
  startOver: () => Promise<BackupInfo>;
  scenariosAvailable: boolean;
}

export function setupApi(
  db: ShiftNurseDb,
  { startOver, scenariosAvailable }: SetupApiOptions,
): ShiftNurseApi['setup'] {
  return {
    status: () => {
      const state = getSetupState(db);
      return { phase: setupPhase(state, listUnits(db).length > 0), state, scenariosAvailable };
    },
    demos: () => DEMO_SUMMARIES.map((d) => ({ ...d, highlights: [...d.highlights] })),
    loadDemo: (demoId) => {
      if (!isDemoId(demoId)) throw new Error(`Unknown demo unit "${demoId}"`);
      return transact(db, (tx) => loadDemo(tx, ACTOR, demoId));
    },
    loadScenarios: () => {
      if (!scenariosAvailable) {
        throw new Error('The test-scenario database is only available in development');
      }
      return transact(db, (tx) => loadScenarios(tx, ACTOR));
    },
    createUnit: (input, mode) => transact(db, (tx) => createSetupUnit(tx, input, mode, ACTOR)),
    advance: (move) => transact(db, (tx) => advanceSetup(tx, move, ACTOR)),
    complete: () => transact(db, (tx) => completeSetup(tx, ACTOR)),
    resume: () => {
      if (listUnits(db).length === 0) throw new Error('Set up a unit before resuming the guide');
      return transact(db, (tx) => startSetup(tx, 'assisted', ACTOR));
    },
    applyPreset: (unitId, preset) =>
      transact(db, (tx) => applySetupPreset(tx, unitId, preset, ACTOR)),
    applyJurisdiction: (unitId, jurisdiction, choices) =>
      transact(db, (tx) => applyJurisdiction(tx, unitId, jurisdiction, ACTOR, choices ?? {})),
    startOver,
  };
}
