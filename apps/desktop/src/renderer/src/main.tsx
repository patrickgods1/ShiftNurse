/**
 * Renderer entry point. Applies the persisted theme before the first paint (so there is no
 * flash of the wrong palette), then mounts React with the two providers every page needs:
 * TanStack Query for IPC data, TanStack Router for navigation.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './router.js';
import './styles.css';
import { applyTheme, loadStoredTheme } from './theme.js';

applyTheme(loadStoredTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // IPC calls hit a local SQLite file, not a network: retries just delay surfacing a real
      // error, and a short stale time keeps pages fresh without refetching on every render.
      retry: false,
      staleTime: 10_000,
    },
  },
});

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('#root element is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
