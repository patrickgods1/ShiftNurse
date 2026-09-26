import { describe, expect, it } from 'vitest';
import { nextSetupStep, previousSetupStep, type SetupState, setupPhase } from './state.js';

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
  it('walks from shift types through to the roster and then the summary', () => {
    expect(nextSetupStep('shift-types')).toBe('coverage');
    expect(nextSetupStep('roster')).toBe('finish');
    expect(nextSetupStep('finish')).toBeUndefined();
  });

  it('has nothing before the first step', () => {
    expect(previousSetupStep('shift-types')).toBeUndefined();
    expect(previousSetupStep('coverage')).toBe('shift-types');
  });
});
