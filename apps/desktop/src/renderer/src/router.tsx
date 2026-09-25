/**
 * Route tree and the shell every route renders inside. Code-based routing (no file-based
 * routing plugin is installed) keeps the route table explicit and small while there are only
 * seven destinations.
 */

import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
} from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import { AsyncState } from './components/async-state.js';
import { ThemeToggle } from './components/theme-toggle.js';
import DashboardPage from './pages/dashboard.js';
import DemandPage from './pages/demand.js';
import FairnessPage from './pages/fairness.js';
import RequestsPage from './pages/requests.js';
import RosterPage from './pages/roster.js';
import SchedulePage from './pages/schedule.js';
import SettingsPage from './pages/settings.js';
import TodayPage from './pages/today.js';
import { UnitProvider, useUnit } from './unit-context.js';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/today', label: 'Today' },
  { to: '/schedule', label: 'Schedule' },
  { to: '/demand', label: 'Demand' },
  { to: '/fairness', label: 'Fairness' },
  { to: '/roster', label: 'Roster' },
  { to: '/requests', label: 'Requests' },
  { to: '/settings', label: 'Settings' },
] as const;

// The main process draws the traffic lights at (16, 16) on macOS (see `main/index.ts`) — a
// sandboxed, context-isolated renderer has no `process.platform`, so this is the standard
// browser-side stand-in. Only macOS's `hiddenInset` title bar paints over the page; everywhere
// else the OS reserves its own title bar and the sidebar's title was never at risk.
const isMacOs = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');

// `WebkitAppRegion` isn't in React's shipped CSSProperties typings; the cast is the standard
// escape hatch rather than a second, looser style type for this one property.
const DRAG_REGION = { WebkitAppRegion: 'drag' } as CSSProperties;

function AppShell() {
  const unit = useUnit();

  return (
    <div className="flex h-screen min-w-[1000px] bg-bg text-text">
      <nav
        aria-label="Primary"
        className="flex w-52 shrink-0 flex-col border-r border-border bg-surface p-3"
      >
        {isMacOs ? (
          // Reserves the row the traffic lights sit in (16px inset + 12px diameter, plus
          // margin) so "ShiftNurse" renders below them instead of behind them, and doubles as
          // the window's drag handle since `hiddenInset` otherwise leaves the title bar
          // undraggable.
          <div className="-mx-3 -mt-3 h-10 shrink-0" style={DRAG_REGION} />
        ) : null}
        <p className="mb-4 px-2 text-sm font-semibold text-text-muted">ShiftNurse</p>
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className="block rounded-md px-3 py-2 text-sm text-text hover:bg-bg
                  [&.active]:bg-accent [&.active]:text-white"
                activeProps={{ className: 'active' }}
                activeOptions={{ exact: item.to === '/' }}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
          <span className="text-sm font-medium text-text">{unit.name}</span>
          <ThemeToggle />
        </header>
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function RootLayout() {
  // Resolves "the" unit once for the whole app; every page below reads it via `useUnitId`/
  // `useUnit` instead of re-fetching `units.list()`.
  return (
    <UnitProvider>
      <AppShell />
    </UnitProvider>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/today',
  component: TodayPage,
});

const scheduleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedule',
  component: SchedulePage,
});

const demandRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/demand',
  component: DemandPage,
});

const fairnessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/fairness',
  component: FairnessPage,
});

const rosterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/roster',
  component: RosterPage,
});

const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/requests',
  component: RequestsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  todayRoute,
  scheduleRoute,
  demandRoute,
  fairnessRoute,
  rosterRoute,
  requestsRoute,
  settingsRoute,
]);

// Electron loads the built renderer from `file://` in production, where a path-based history
// can't resolve on refresh/deep-link; hash history keeps routing working under that protocol.
// A render exception inside one page shows here, inside the shell, instead of unmounting the
// whole app to a blank window with the nav gone.
export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultErrorComponent: ({ error }) => (
    <AsyncState status="error" label="This page failed to load" error={error} />
  ),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
