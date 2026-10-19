/**
 * Loading a seeded dataset at setup: seed code sits above the repositories, so this lives here,
 * not in `repositories/setup.ts` (which the demo engine imports).
 */

import type { Id, Unit } from '@shiftnurse/core';
import type { ShiftNurseTx } from '../client.js';
import { getUnit } from '../repositories/config.js';
import { refuseIfConfigured, startSetup } from '../repositories/setup.js';
import { type DemoId, isDemoId, seedDemoUnit } from './demo.js';
import { seedScenarioUnit } from './scenarios.js';

/**
 * Seed one of the realistic demo units (the community med-surg unit unless another is named)
 * and mark setup done. Only on an empty install: never seed twice.
 */
export function loadDemo(tx: ShiftNurseTx, actor: string, demo?: DemoId): Unit {
  if (demo !== undefined && !isDemoId(demo)) throw new Error(`Unknown demo unit "${demo}"`);
  return loadSeeded(tx, 'demo', () => seedDemoUnit(tx, { demo }).unitId, actor);
}

/**
 * Seed the test-scenario unit, the dataset the automated tests are built on, for trying a change
 * by hand against the same planted problems. Developer-only: the caller decides who may.
 */
export function loadScenarios(tx: ShiftNurseTx, actor: string): Unit {
  return loadSeeded(tx, 'scenarios', () => seedScenarioUnit(tx).unitId, actor);
}

function loadSeeded(
  tx: ShiftNurseTx,
  mode: 'demo' | 'scenarios',
  seed: () => Id,
  actor: string,
): Unit {
  refuseIfConfigured(tx);
  const unitId = seed();
  startSetup(tx, mode, actor);
  const unit = getUnit(tx, unitId);
  if (!unit) throw new Error(`Seeded unit ${unitId} not found`);
  return unit;
}
