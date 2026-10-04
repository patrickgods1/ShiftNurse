/**
 * Renderer entry point. Applies the persisted theme before the first paint (so there is no
 * flash of the wrong palette), then mounts React with the providers every page needs:
 * TanStack Query for IPC data, toasts for failures nothing else shows, TanStack Router for
 * navigation.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createQueryClient } from './query-client.js';
import { router } from './router.js';
import './styles.css';
import { ConfirmProvider } from './components/confirm.js';
import { AppErrorBoundary } from './components/error-boundary.js';
import { ToastProvider } from './components/toast.js';
import { applyTheme, loadStoredTheme } from './theme.js';

applyTheme(loadStoredTheme());

const queryClient = createQueryClient();

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('#root element is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
