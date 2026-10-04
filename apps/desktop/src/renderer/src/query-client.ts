/**
 * The renderer's one QueryClient, built here (not inline in `main.tsx`) so tests exercise the
 * same mutation-error policy the app runs.
 *
 * About a hundred mutations are called across the app and only a few dozen render their own
 * failure; the rest used to fail with nothing on screen. Every mutation error therefore becomes a
 * toast, except where the call site shows it inline (`meta: { inlineError: true }`), so the
 * manager sees a failure once and never zero times. A hook shared by several components sets the
 * flag only if all of them show the error: a duplicate is better than silence.
 */

import { MutationCache, QueryClient } from '@tanstack/react-query';
import { toastBus } from './components/toast.js';
import { errorMessage } from './components/ui.js';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { inlineError?: boolean };
  }
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.inlineError === true) return;
        toastBus.emit({ message: errorMessage(error) ?? 'Something went wrong', tone: 'error' });
      },
    }),
    defaultOptions: {
      queries: {
        // IPC calls hit a local SQLite file, not a network: retries just delay surfacing a real
        // error, and a short stale time keeps pages fresh without refetching on every render.
        retry: false,
        staleTime: 10_000,
      },
    },
  });
}
