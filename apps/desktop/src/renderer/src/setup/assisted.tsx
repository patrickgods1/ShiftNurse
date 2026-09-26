/**
 * The assisted setup guide: one step per configuration area, each skippable. Progress is
 * saved on every move (`setup.advance`), so a manager who closes the app halfway comes back to
 * the step they were on rather than a half-configured unit with no way back into the guide.
 */

import {
  nextSetupStep,
  previousSetupStep,
  SETUP_STEPS,
  type SetupState,
  type SetupStepId,
} from '@shiftnurse/core';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useAdvanceSetup, useCompleteSetup } from '../api-setup.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { errorMessage, PRIMARY, SECONDARY } from '../components/ui.js';
import { useUnit } from '../unit-context.js';
import { StepBody } from './assisted-steps.js';
import { STEP_TITLES } from './steps.js';

export function AssistedSetup({ state }: { state: SetupState }) {
  const unit = useUnit();
  const navigate = useNavigate();
  const advance = useAdvanceSetup();
  const complete = useCompleteSetup();
  const step: SetupStepId = state.currentStep ?? SETUP_STEPS[0];
  const next = nextSetupStep(step);
  const previous = previousSetupStep(step);
  const busy = advance.isPending || complete.isPending;
  const heading = useRef<HTMLHeadingElement>(null);

  // A new step replaces the whole body; move focus to its heading so a keyboard or screen
  // reader user is not left on a button that no longer exists.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per step change.
  useEffect(() => heading.current?.focus(), [step]);

  const go = (to: SetupStepId | undefined, skipped: boolean) => {
    if (to !== undefined) advance.mutate({ from: step, to, skipped });
  };

  const finish = () => complete.mutate(undefined, { onSuccess: () => void navigate({ to: '/' }) });

  return (
    <div className="flex h-screen min-w-[1000px] bg-bg text-text" data-testid="setup-assisted">
      <nav
        aria-label="Setup steps"
        className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-surface p-3 pt-12"
      >
        <p className="mb-3 px-2 text-sm font-semibold text-text-muted">Setting up {unit.name}</p>
        <ol className="flex flex-col gap-1">
          {SETUP_STEPS.map((s, index) => (
            <li
              key={s}
              aria-current={s === step ? 'step' : undefined}
              className={`rounded-md px-3 py-2 text-sm ${
                s === step ? 'bg-accent text-white' : 'text-text'
              }`}
            >
              {index + 1}. {STEP_TITLES[s]}
              {state.skippedSteps.includes(s) && s !== step ? (
                <span className="ml-1 text-xs text-text-muted">(skipped)</span>
              ) : null}
            </li>
          ))}
        </ol>
      </nav>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
          <h1 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
            {STEP_TITLES[step]}
          </h1>
          <ThemeToggle />
        </header>
        <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
          <StepBody step={step} skipped={state.skippedSteps} />
        </main>
        <footer className="flex items-center justify-between gap-3 border-t border-border bg-surface px-6 py-3">
          <button
            type="button"
            className={SECONDARY}
            disabled={busy || previous === undefined}
            // Going back neither completes nor skips the step being left.
            onClick={() => go(previous, state.skippedSteps.includes(step))}
          >
            Back
          </button>
          <div className="flex items-center gap-3">
            {advance.isError || complete.isError ? (
              <span role="alert" className="text-sm text-danger">
                {errorMessage(advance.error ?? complete.error)}
              </span>
            ) : null}
            {next !== undefined ? (
              <>
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={busy}
                  onClick={() => go(next, true)}
                  data-testid="setup-skip"
                >
                  Skip for now
                </button>
                <button
                  type="button"
                  className={PRIMARY}
                  disabled={busy}
                  onClick={() => go(next, false)}
                  data-testid="setup-continue"
                >
                  Continue
                </button>
              </>
            ) : (
              <button
                type="button"
                className={PRIMARY}
                disabled={busy}
                onClick={finish}
                data-testid="setup-finish"
              >
                Open ShiftNurse
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
