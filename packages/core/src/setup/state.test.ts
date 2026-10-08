import { describe, expect, it } from 'vitest';
import {
  nextSetupStep,
  previousSetupStep,
  SETUP_STEPS,
  type SetupState,
  setupPhase,
} from './state.js';

const assisted: SetupState = {
  mode: 'assisted',
  status: 'in_progress',
  currentStep: 'coverage',
  skippedSteps: [],
  startedAt: 1,
  completedAt: null,
};

describe('setupPhase', () => {
  it('greets a brand-new install with the welcome screen', () => {
    expect(setupPhase(undefined, false)).toBe('welcome');
  });

  it('opens straight into the app for an install upgraded from before setup existed', () => {
    // The unit was seeded by an older version; no setup row was ever written.
    expect(setupPhase(undefined, true)).toBe('ready');
  });

  it('returns a manager who quit halfway through the guide to where they left off', () => {
    expect(setupPhase(assisted, true)).toBe('assisted');
  });

  it('opens the app once the guide is finished', () => {
    expect(setupPhase({ ...assisted, status: 'complete', completedAt: 2 }, true)).toBe('ready');
  });

  it('shows the welcome screen again when there is no unit, whatever the row says', () => {
    expect(setupPhase(assisted, false)).toBe('welcome');
  });
});

describe('step order', () => {
  it('starts with state law, then shifts, and ends on the roster and the summary', () => {
    expect(SETUP_STEPS).toEqual([
      'state',
      'shift-types',
      'coverage',
      'acuity',
      'holidays',
      'rules',
      'pay',
      'unit',
      'leave',
      'requests',
      'roster',
      'finish',
    ]);
  });

  it("puts state law first, so its ratios and overtime land under the manager's own choices", () => {
    expect(previousSetupStep('state')).toBeUndefined();
    expect(nextSetupStep('state')).toBe('shift-types');
    expect(previousSetupStep('shift-types')).toBe('state');
  });

  it('walks from pay through unit policies, leave and requests to the roster', () => {
    expect(nextSetupStep('pay')).toBe('unit');
    expect(nextSetupStep('unit')).toBe('leave');
    expect(nextSetupStep('leave')).toBe('requests');
    expect(nextSetupStep('requests')).toBe('roster');
    expect(previousSetupStep('roster')).toBe('requests');
  });

  it('ends on the summary after the roster', () => {
    expect(nextSetupStep('roster')).toBe('finish');
    expect(nextSetupStep('finish')).toBeUndefined();
  });

  it('still steps between shift types and staffing floors', () => {
    expect(nextSetupStep('shift-types')).toBe('coverage');
    expect(previousSetupStep('coverage')).toBe('shift-types');
  });
});
