/**
 * Unit configuration home: shift types, coverage floors, pay and holidays feed the solver, the
 * schedule grid and the cost engine, so they live together as tabs of one "Settings"
 * destination rather than as separate nav entries. About keeps the existing app-info + theme content.
 */

import { type KeyboardEvent, useState } from 'react';
import { api, useAppInfo } from '../api.js';
import { AsyncState } from '../components/async-state.js';
import { PageHeader } from '../components/page-header.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { SECONDARY } from '../components/ui.js';
import { useConfirmDiscard } from '../components/unsaved-changes.js';
import AcuityPanel from './settings/acuity.js';
import BackupsPanel from './settings/backups.js';
import ConflictsPanel from './settings/conflicts.js';
import { CoverageTab } from './settings/coverage-tab.js';
import HolidaysPanel from './settings/holidays.js';
import PayPanel from './settings/pay.js';
import RulesPanel from './settings/rules.js';
import ShiftTypesPanel from './settings/shift-types.js';
import SolverPanel from './settings/solver.js';
import UnitPanel from './settings/unit.js';

const TABS = [
  { id: 'unit', label: 'Unit' },
  { id: 'shift-types', label: 'Shift types' },
  { id: 'coverage', label: 'Coverage floors' },
  { id: 'acuity', label: 'Acuity' },
  { id: 'rules', label: 'Rules' },
  { id: 'pay', label: 'Pay' },
  { id: 'solver', label: 'Solver' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'holidays', label: 'Holidays' },
  { id: 'backups', label: 'Backups' },
  { id: 'about', label: 'About' },
] as const;

type TabId = (typeof TABS)[number]['id'];

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
    </section>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>('unit');
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
      ArrowRight: (index + 1) % count,
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

      <div
        data-testid="settings-tabs"
        role="tablist"
        aria-label="Settings sections"
        className="mb-4 flex gap-1 overflow-x-auto border-b border-border"
      >
        {TABS.map((tab) => (
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
            className={`shrink-0 whitespace-nowrap rounded-t-md px-3 py-2 text-sm font-medium ${
              activeTab === tab.id
                ? 'border-b-2 border-accent text-text'
                : 'text-text-muted hover:text-text'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

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
              <ConflictsPanel />
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
  );
}
