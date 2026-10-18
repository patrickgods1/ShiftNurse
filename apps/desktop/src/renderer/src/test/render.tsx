/**
 * Renders a component inside the app's providers, so a test fails for what the component does
 * and not because a context was missing. They are not stacked exactly as the app stacks them:
 * `TipProvider` and `UnsavedChangesProvider` wrap the router here rather than sitting inside
 * `RootLayout`, and there is no `NavigationGuard` or `SetupGate`. So route blocking on unsaved
 * changes is not exercised; a test of it needs the real layout. The router is a memory-history
 * one whose only route renders `ui` wherever the URL points, enough for `Link` and
 * `useNavigate` to work without the page shell.
 *
 * Pages read the unit through `UnitProvider`, which asks `units.home`; pass `unit` and this
 * scripts that answer (and `units.list` as `[unit]`, for pickers) on the installed fake bridge.
 */

import type { Unit } from '@shiftnurse/core';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ConfirmProvider } from '../components/confirm.js';
import { TipProvider } from '../components/field-help.js';
import { ToastProvider } from '../components/toast.js';
import { UnsavedChangesProvider } from '../components/unsaved-changes.js';
import { createQueryClient } from '../query-client.js';
import { SelectedPeriodProvider } from '../selected-period.js';
import { UnitProvider } from '../unit-context.js';
import { getActiveBridge } from './fake-bridge.js';

export interface RenderWithAppOptions {
  /** Initial URL of the memory history. */
  route?: string;
  /** Wrap in `UnitProvider` with this unit as the home unit and the only one `units.list` returns. */
  unit?: Unit;
}

export interface AppRenderResult extends RenderResult {
  queryClient: QueryClient;
}

/**
 * The router resolves its first match asynchronously, so `ui` appears a tick after this
 * returns: query with `findBy…`, not `getBy…`, for the first thing on screen.
 */
export function renderWithApp(
  ui: ReactElement,
  options: RenderWithAppOptions = {},
): AppRenderResult {
  // The app's own client, so a mutation error becomes the toast it would be in the app.
  const queryClient = createQueryClient();

  const { unit } = options;
  // Overwrites any earlier units scripts: asking for a unit is asking for this one.
  if (unit !== undefined) {
    getActiveBridge()?.respond('units', 'home', unit);
    getActiveBridge()?.respond('units', 'list', [unit]);
  }
  const body = unit === undefined ? ui : <UnitProvider>{ui}</UnitProvider>;

  const rootRoute = createRootRoute({ component: () => body });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [options.route ?? '/'] }),
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <TipProvider>
            <UnsavedChangesProvider>
              <SelectedPeriodProvider>
                <RouterProvider router={router} />
              </SelectedPeriodProvider>
            </UnsavedChangesProvider>
          </TipProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return Object.assign(result, { queryClient });
}
