/**
 * Unit configuration home: shift types, coverage floors, pay and holidays feed the solver, the
 * schedule grid and the cost engine, so they live together as tabs of one "Settings"
 * destination rather than as separate nav entries. About keeps the existing app-info + theme content.
 */

import { useSearch } from '@tanstack/react-router';
import { type KeyboardEvent, useState } from 'react';
import { api, useAppInfo } from '../api.js';
import { AsyncState } from '../components/async-state.js';
import { PageHeader } from '../components/page-header.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { SECONDARY } from '../components/ui.js';
import { useConfirmDiscard } from '../components/unsaved-changes.js';
import { NOT_ENFORCED, PRESETS_DISCLAIMER } from '../limits.js';
import AcuityPanel from './settings/acuity.js';
import BackupsPanel from './settings/backups.js';
import CancellationOrderPanel from './settings/cancellation-order.js';
import ConflictsPanel from './settings/conflicts.js';
import { CoverageTab } from './settings/coverage-tab.js';
import HolidaysPanel from './settings/holidays.js';
import PayPanel from './settings/pay.js';
import RulesPanel from './settings/rules.js';
import ShiftTypesPanel from './settings/shift-types.js';
import SolverPanel from './settings/solver.js';
import UnitPanel from './settings/unit.js';

// Grouped by the question a manager brings, not by the module that owns the data. Ids are the
// URL's `tab` value and the smoke test's selectors, so a relabel never renames one.
const GROUPS = [
  {
    id: 'unit',
    heading: 'My unit',
    tabs: [
      { id: 'unit', label: 'Unit' },
      { id: 'shift-types', label: 'Shift types' },
      { id: 'coverage', label: 'Coverage floors' },
      { id: 'acuity', label: 'Acuity' },
      { id: 'holidays', label: 'Holidays' },
    ],
  },
  {
    id: 'contract',
    heading: 'Contract & pay',
    tabs: [
      { id: 'rules', label: 'Rules' },
      { id: 'pay', label: 'Pay' },
    ],
  },
  {
    id: 'scheduling',
    heading: 'Scheduling',
    tabs: [
      { id: 'solver', label: 'Schedule builder' },
      { id: 'conflicts', label: 'Requests' },
    ],
  },
  {
    id: 'data',
    heading: 'Data',
    tabs: [
      { id: 'backups', label: 'Backups' },
      { id: 'about', label: 'About' },
    ],
  },
] as const;

const TABS = GROUPS.flatMap((g) => [...g.tabs]);

type TabId = (typeof TABS)[number]['id'];

function tabFromSearch(value: unknown): TabId | undefined {
  return TABS.find((t) => t.id === value)?.id;
}

function AboutTab() {
  const appInfoQuery = useAppInfo();

  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold text-text">Appearance</h2>
      <ThemeToggle />

      <h2 className="mb-3 mt-6 text-sm font-semibold text-text">About</h2>
      {appInfoQuery.isPending ? (
        <AsyncState status="loading" label="Loading app info" />
      ) : appInfoQuery.isError ? (
        <AsyncState status="error" label="Could not load app info" error={appInfoQuery.error} />
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-text-muted">Version</dt>
          <dd className="text-text">{appInfoQuery.data.version}</dd>
          <dt className="text-text-muted">Platform</dt>
          <dd className="text-text">{appInfoQuery.data.platform}</dd>
          <dt className="text-text-muted">Database</dt>
          <dd className="break-all text-text">{appInfoQuery.data.databasePath}</dd>
        </dl>
      )}

      <h2 className="mb-1 mt-6 text-sm font-semibold text-text">Support</h2>
      <p className="mb-3 text-sm text-text-muted">
        The log records backups, errors and solver runs. Attach it when you report a problem.
      </p>
      <button type="button" className={SECONDARY} onClick={() => void api.app.openLogs()}>
        Open logs folder
      </button>

      <h2 className="mb-1 mt-6 text-sm font-semibold text-text">
        What ShiftNurse does not enforce yet
      </h2>
      <p className="mb-2 text-sm text-text-muted">
        Each of these is yours to do by hand until the app handles it.
      </p>
      <ul className="list-disc pl-5 text-sm text-text" data-testid="not-enforced">
        {NOT_ENFORCED.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-text-muted">{PRESETS_DISCLAIMER}</p>
    </section>
  );
}

export default function SettingsPage() {
  // `?tab=` opens a tab from a link elsewhere in the app; a later change to it (a second link
  // while this page is open) is followed once, then the manager's own clicks take over.
  const requested = tabFromSearch(useSearch({ strict: false }).tab);
  const [activeTab, setActiveTab] = useState<TabId>(requested ?? 'unit');
  const [seenRequest, setSeenRequest] = useState(requested);
  if (requested !== seenRequest) {
    setSeenRequest(requested);
    if (requested !== undefined) setActiveTab(requested);
  }
  const confirmDiscard = useConfirmDiscard();

  // Leaving a tab unmounts its panel, and with it any edits not yet saved.
  const selectTab = async (id: TabId): Promise<boolean> => {
    if (id === activeTab) return true;
    if (!(await confirmDiscard())) return false;
    setActiveTab(id);
    return true;
  };

  // The ARIA tabs pattern: one tab stop for the whole row, arrows move between tabs.
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((t) => t.id === activeTab);
    const count = TABS.length;
    const targets: Record<string, number> = {
      ArrowDown: (index + 1) % count,
      ArrowRight: (index + 1) % count,
      ArrowUp: (index - 1 + count) % count,
      ArrowLeft: (index - 1 + count) % count,
      Home: 0,
      End: count - 1,
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = TABS[next]!;
    void selectTab(tab.id).then((moved) => {
      if (moved) document.getElementById(`settings-tab-${tab.id}`)?.focus();
    });
  };

  return (
    <div>
      <PageHeader title="Settings" />

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {/* One tablist per group: a tablist may own only tabs, so each heading sits outside its
            list and names it. Arrow keys still walk all four lists as one sequence. */}
        <div data-testid="settings-tabs" className="flex shrink-0 flex-col gap-4 md:w-48">
          {GROUPS.map((group) => (
            <div key={group.heading}>
              <h2
                id={`settings-group-${group.id}`}
                className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-text-muted"
              >
                {group.heading}
              </h2>
              <div
                role="tablist"
                aria-orientation="vertical"
                aria-labelledby={`settings-group-${group.id}`}
              >
                {group.tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    id={`settings-tab-${tab.id}`}
                    aria-selected={activeTab === tab.id}
                    aria-controls={`settings-panel-${tab.id}`}
                    tabIndex={activeTab === tab.id ? 0 : -1}
                    onClick={() => void selectTab(tab.id)}
                    onKeyDown={onTabKeyDown}
                    className={`block w-full whitespace-nowrap rounded-md px-3 py-1.5 text-left text-sm font-medium ${
                      activeTab === tab.id
                        ? 'bg-bg text-text shadow-[inset_2px_0_0_var(--color-accent)]'
                        : 'text-text-muted hover:text-text'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          {TABS.map((tab) => (
            <div
              key={tab.id}
              role="tabpanel"
              id={`settings-panel-${tab.id}`}
              aria-labelledby={`settings-tab-${tab.id}`}
              hidden={activeTab !== tab.id}
            >
              {activeTab === tab.id ? (
                tab.id === 'unit' ? (
                  <UnitPanel />
                ) : tab.id === 'shift-types' ? (
                  <ShiftTypesPanel />
                ) : tab.id === 'coverage' ? (
                  <CoverageTab />
                ) : tab.id === 'acuity' ? (
                  <AcuityPanel />
                ) : tab.id === 'rules' ? (
                  <RulesPanel />
                ) : tab.id === 'pay' ? (
                  <PayPanel />
                ) : tab.id === 'solver' ? (
                  <SolverPanel />
                ) : tab.id === 'conflicts' ? (
                  <div className="flex flex-col gap-4">
                    <ConflictsPanel />
                    <CancellationOrderPanel />
                  </div>
                ) : tab.id === 'holidays' ? (
                  <HolidaysPanel />
                ) : tab.id === 'backups' ? (
                  <BackupsPanel />
                ) : (
                  <AboutTab />
                )
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
