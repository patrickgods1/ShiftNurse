/**
 * Decides what a launch shows: the welcome screen on an empty install, the assisted guide
 * while it is in progress, otherwise the app. The decision is main's (`setup.status`, via
 * core's `setupPhase`); this only routes on it.
 */

import type { ReactNode } from 'react';
import { useSetupStatus } from '../api-setup.js';
import { AsyncState } from '../components/async-state.js';
import { UnitProvider } from '../unit-context.js';
import { AssistedSetup } from './assisted.js';
import { WelcomeScreen } from './welcome.js';

export function SetupGate({ children }: { children: ReactNode }) {
  const statusQuery = useSetupStatus();

  if (statusQuery.isPending) return <AsyncState status="loading" label="Starting ShiftNurse" />;
  if (statusQuery.isError) {
    return (
      <AsyncState status="error" label="Could not start ShiftNurse" error={statusQuery.error} />
    );
  }
  const { phase, state, scenariosAvailable } = statusQuery.data;
  if (phase === 'welcome') return <WelcomeScreen scenariosAvailable={scenariosAvailable} />;
  if (phase === 'assisted' && state !== undefined) {
    return (
      <UnitProvider>
        <AssistedSetup state={state} />
      </UnitProvider>
    );
  }
  return <>{children}</>;
}
