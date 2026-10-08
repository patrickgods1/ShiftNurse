/**
 * First launch: the database is empty and the manager chooses what goes in it. A demo is a
 * fictional unit for evaluating the product, picked from a list of different kinds of unit;
 * manual and assisted both start with the manager's own unit, the difference being whether the
 * guide walks them through its configuration.
 */

import { useState } from 'react';
import { useCreateSetupUnit, useLoadScenarios } from '../api-setup.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { errorMessage } from '../components/ui.js';
import { DemoPicker } from './demo-picker.js';
import { UnitForm } from './unit-form.js';

type Choice = 'choose' | 'demo' | 'manual' | 'assisted';

const CARD =
  'flex flex-col gap-2 rounded-lg border border-border bg-surface p-5 text-left hover:border-accent disabled:opacity-50';

export function WelcomeScreen({ scenariosAvailable }: { scenariosAvailable: boolean }) {
  const [choice, setChoice] = useState<Choice>('choose');
  const loadScenarios = useLoadScenarios();
  const createUnit = useCreateSetupUnit();
  const loading = loadScenarios.isPending;

  return (
    <div className="flex min-h-screen flex-col bg-bg text-text" data-testid="setup-welcome">
      <header className="flex justify-end p-4">
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 pb-12">
        <div>
          <h1 className="text-2xl font-semibold">Welcome to ShiftNurse</h1>
          <p className="mt-1 text-sm text-text-muted">
            {choice === 'choose'
              ? 'How would you like to start? You can change everything later in Settings.'
              : choice === 'demo'
                ? 'Pick the demo unit closest to yours. Each runs on its own shifts, staffing rules and pay rules.'
                : choice === 'manual'
                  ? 'Name your unit. Everything else starts empty and is set up from Settings and Roster.'
                  : 'Name your unit first. The guide then walks through state law, shifts, staffing, acuity and ratios, holidays, rules, pay, unit policies, leave, requests and your roster.'}
          </p>
        </div>

        {choice === 'choose' ? (
          <div className="grid gap-4">
            <button
              type="button"
              className={CARD}
              data-testid="setup-choose-assisted"
              onClick={() => setChoice('assisted')}
              disabled={loading}
            >
              <span className="font-semibold">Guided setup</span>
              <span className="text-sm text-text-muted">
                Set up your own unit step by step, with ready-made options to choose from on each
                page. Skip any step and come back to it later.
              </span>
            </button>
            <button
              type="button"
              className={CARD}
              data-testid="setup-choose-manual"
              onClick={() => setChoice('manual')}
              disabled={loading}
            >
              <span className="font-semibold">Manual setup</span>
              <span className="text-sm text-text-muted">
                Start with an empty unit: no shifts, rules or roster. For managers who know exactly
                what they want to enter or will import it.
              </span>
            </button>
            <button
              type="button"
              className={CARD}
              data-testid="setup-choose-demo"
              onClick={() => setChoice('demo')}
              disabled={loading}
            >
              <span className="font-semibold">Explore a demo unit</span>
              <span className="text-sm text-text-muted">
                Choose from realistic fictional units: a community med-surg unit, a VA
                medicine-surgery ward in San Francisco, or a California ICU. Each comes with six
                months of history, a schedule ready to generate and requests waiting for a decision.
              </span>
            </button>
            {scenariosAvailable ? (
              <button
                type="button"
                className={`${CARD} border-dashed`}
                data-testid="setup-choose-scenarios"
                onClick={() => loadScenarios.mutate()}
                disabled={loading}
              >
                <span className="font-semibold">
                  {loadScenarios.isPending
                    ? 'Loading the test scenarios…'
                    : 'Load test scenarios (development only)'}
                </span>
                <span className="text-sm text-text-muted">
                  The dataset the automated tests use: planted PTO conflicts, expiring ACLS, skewed
                  night history, an on-call shift and LPNs. Shown only under npm run dev.
                </span>
              </button>
            ) : null}
            {loadScenarios.isError ? (
              <p role="alert" className="text-sm text-danger">
                The test scenarios could not be loaded: {errorMessage(loadScenarios.error)}
              </p>
            ) : null}
          </div>
        ) : choice === 'demo' ? (
          <DemoPicker onBack={() => setChoice('choose')} />
        ) : (
          <div className="rounded-lg border border-border bg-surface p-5">
            <UnitForm
              submitLabel={choice === 'assisted' ? 'Create unit and continue' : 'Create unit'}
              pending={createUnit.isPending}
              error={createUnit.error}
              onBack={() => {
                createUnit.reset();
                setChoice('choose');
              }}
              onSubmit={(input) => createUnit.mutate({ input, mode: choice })}
            />
          </div>
        )}
      </main>
    </div>
  );
}
