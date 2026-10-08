/**
 * What a launch opens: a fresh install must land on the welcome screen with nothing in the
 * database, a manager who quits halfway through the guide must come back to it, and neither
 * the demo nor a new unit may be written over a unit that already exists.
 */

import { isoDate } from '@shiftnurse/core';
import {
  createUnit,
  getUnit,
  listActiveRatioRulesForUnit,
  listOvertimeRulesForUnit,
  listShiftTypesForUnit,
  type OpenedDatabase,
  openTestDatabase,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupInfo } from '../../shared/api.js';
import { ACTOR } from './context.js';
import { setupApi } from './setup.js';

// Several tests seed a whole demo unit (six months of history), about a second locally and
// several on a slow Windows CI runner: past vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000 });

let handle: OpenedDatabase;
let setup: ReturnType<typeof setupApi>;

const unitInput = {
  name: '5 East',
  unitType: 'Telemetry',
  payPeriodDays: 14,
  payPeriodAnchor: isoDate('2026-09-20'),
};

const startOver = () => Promise.reject(new Error('not in tests')) as Promise<BackupInfo>;

beforeEach(() => {
  handle = openTestDatabase();
  setup = setupApi(handle.db, { startOver, scenariosAvailable: false });
});

afterEach(() => handle.close());

describe('first launch', () => {
  it('opens a brand-new install on the welcome screen', () => {
    expect(setup.status()).toEqual({
      phase: 'welcome',
      state: undefined,
      scenariosAvailable: false,
    });
  });

  it('opens an install from before first-run setup straight into the app', () => {
    createUnit(handle.db, unitInput, ACTOR);
    expect(setup.status()).toMatchObject({ phase: 'ready', state: undefined });
  });

  it('offers the three demo units, the community med-surg unit first', () => {
    expect(setup.demos().map((d) => d.id)).toEqual([
      'community-med-surg',
      'va-sf-med-surg',
      'ca-icu',
    ]);
  });

  it('loads the demo unit the manager picked', () => {
    expect(setup.loadDemo('ca-icu').unitType).toBe('ICU');
  });

  it('refuses a demo id that is not on the list', () => {
    expect(() => setup.loadDemo('nope')).toThrow(/Unknown demo unit/);
    expect(setup.status().phase).toBe('welcome');
  });

  it('refuses the test-scenario database in an installed app', () => {
    expect(() => setup.loadScenarios()).toThrow(/only available in development/);
    expect(setup.status().phase).toBe('welcome');
  });

  it('loads the test-scenario database in development', () => {
    const dev = setupApi(handle.db, { startOver, scenariosAvailable: true });
    expect(dev.status().scenariosAvailable).toBe(true);
    dev.loadScenarios();
    expect(dev.status()).toMatchObject({ phase: 'ready', state: { mode: 'scenarios' } });
  });

  it('goes straight to the app after the demo loads, and will not load it twice', () => {
    setup.loadDemo('community-med-surg');
    expect(setup.status().phase).toBe('ready');
    expect(() => setup.loadDemo('community-med-surg')).toThrow(/already has a unit/);
  });

  it('goes straight to an empty app after a manual setup', () => {
    const unit = setup.createUnit(unitInput, 'manual');
    expect(setup.status()).toMatchObject({ phase: 'ready', state: { mode: 'manual' } });
    expect(listShiftTypesForUnit(handle.db, unit.id)).toEqual([]);
  });

  it('brings a manager who quit mid-guide back to the step they were on', () => {
    setup.createUnit(unitInput, 'assisted');
    setup.advance({ from: 'shift-types', to: 'coverage', skipped: true });
    // …the app is closed and relaunched: status is read afresh from the database.
    expect(setup.status()).toMatchObject({
      phase: 'assisted',
      state: { currentStep: 'coverage', skippedSteps: ['shift-types'] },
    });
    setup.complete();
    expect(setup.status().phase).toBe('ready');
  });

  it('reopens the guide from Settings on the existing unit', () => {
    setup.createUnit(unitInput, 'manual');
    setup.resume();
    expect(setup.status()).toMatchObject({
      phase: 'assisted',
      state: { mode: 'assisted', currentStep: 'state' },
    });
  });

  it('refuses to resume the guide before any unit exists', () => {
    expect(() => setup.resume()).toThrow(/Set up a unit/);
  });
});

describe('applying a state preset', () => {
  it("sets a telemetry unit to California's 1:4 and remembers the state on the unit", () => {
    const unit = setup.createUnit(unitInput, 'manual');
    // No alternative-workweek answer: 1 ratio rule + 5 overtime rules (daily 8, daily 12, weekly
    // 40, both seventh-day); the 12-in-24 cap is not switched on, so no rule set.
    expect(setup.applyJurisdiction(unit.id, 'CA')).toMatchObject({ created: 6 });
    expect(listActiveRatioRulesForUnit(handle.db, unit.id)).toEqual([
      expect.objectContaining({ role: 'RN', maxPatientsPerNurse: 4 }),
    ]);
    expect(getUnit(handle.db, unit.id)?.jurisdiction).toBe('CA');
    expect(setup.applyJurisdiction(unit.id, 'CA')).toEqual({
      created: 0,
      updated: 0,
      unchanged: 1,
    });
  });

  it('applies California’s alternative-workweek reading when the manager says the unit runs one', () => {
    const unit = setup.createUnit(unitInput, 'manual');
    setup.applyJurisdiction(unit.id, 'CA', { alternativeWorkweek: true });
    const rules = listOvertimeRulesForUnit(handle.db, unit.id);
    expect(rules.some((r) => r.basis === 'daily' && r.thresholdHours === 8)).toBe(false);
    expect(rules.some((r) => r.basis === 'beyond_scheduled_days')).toBe(true);
  });

  it('refuses a unit that does not exist', () => {
    expect(() => setup.applyJurisdiction('unit_missing', 'NY')).toThrow(/not found/);
  });
});
