// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from './components/toast.js';
import { createQueryClient } from './query-client.js';
import { type FakeBridge, installFakeBridge } from './test/fake-bridge.js';

// Imported after the bridge module so `api.ts` captures the fake (see fake-bridge.ts).
const { useSetBudget } = await import('./api-cost.js');
const { useSaveConflictPolicy } = await import('./api-requests.js');

function Buttons() {
  const budget = useSetBudget('period-1');
  const policy = useSaveConflictPolicy('unit-1');
  return (
    <>
      <button type="button" onClick={() => budget.mutate(5000)}>
        Set budget
      </button>
      <button
        type="button"
        onClick={() =>
          policy.mutate({} as Parameters<typeof policy.mutate>[0], { onError: () => {} })
        }
      >
        Save policy
      </button>
    </>
  );
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  bridge.fail('cost', 'setBudget', new Error('The budget could not be saved.'));
  bridge.fail('conflicts', 'savePolicy', new Error('The policy could not be saved.'));
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <Buttons />
      </ToastProvider>
    </QueryClientProvider>,
  );
});
afterEach(() => {
  cleanup();
  bridge.uninstall();
});

describe('a failed save reaches the manager', () => {
  it('toasts the failure of a mutation whose screen shows nothing itself', async () => {
    fireEvent.click(screen.getByText('Set budget'));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The budget could not be saved.',
    );
  });

  it('does not toast a mutation whose panel already shows the error inline', async () => {
    fireEvent.click(screen.getByText('Save policy'));
    await waitFor(() => expect(bridge.callsTo('conflicts', 'savePolicy')).toHaveLength(1));
    // Let the rejection settle through the mutation cache before asserting on silence.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
