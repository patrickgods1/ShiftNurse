/**
 * Unit configuration home: shift types, coverage floors, pay and holidays feed the solver, the
 * schedule grid and the cost engine, so they live together as tabs of one "Settings"
 * destination rather than as separate nav entries. About keeps the existing app-info + theme content.
 */

import { useState } from 'react';
import { useAppInfo } from '../api.js';
import { useCoverage, useShiftTypesList } from '../api-config.js';
import { AsyncState } from '../components/async-state.js';
import { PageHeader } from '../components/page-header.js';
import { ThemeToggle } from '../components/theme-toggle.js';
import { useUnitId } from '../unit-context.js';
import AcuityPanel from './settings/acuity.js';
import BackupsPanel from './settings/backups.js';
import ConflictsPanel from './settings/conflicts.js';
import CoverageFloors from './settings/coverage-floors.js';
import HolidaysPanel from './settings/holidays.js';
import PayPanel from './settings/pay.js';
import RulesPanel from './settings/rules.js';
import ShiftTypesPanel from './settings/shift-types.js';

const TABS = [
  { id: 'shift-types', label: 'Shift types' },
  { id: 'coverage', label: 'Coverage floors' },
  { id: 'acuity', label: 'Acuity' },
  { id: 'rules', label: 'Rules' },
  { id: 'pay', label: 'Pay' },
  { id: 'conflicts', label: 'Conflicts' },
  { id: 'holidays', label: 'Holidays' },
  { id: 'backups', label: 'Backups' },
  { id: 'about', label: 'About' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function CoverageTab() {
  const unitId = useUnitId();
  const shiftTypesQuery = useShiftTypesList(unitId);
  const coverageQuery = useCoverage(unitId);

  if (shiftTypesQuery.isPending || coverageQuery.isPending) {
    return <AsyncState status="loading" label="Loading coverage floors" />;
  }
  if (shiftTypesQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load shift types" error={shiftTypesQuery.error} />
    );
  }
  if (coverageQuery.isError) {
    return (
      <AsyncState
        status="error"
        label="Could not load coverage floors"
        error={coverageQuery.error}
      />
    );
  }

  return (
    <CoverageFloors
      unitId={unitId}
      shiftTypes={shiftTypesQuery.data}
      requirements={coverageQuery.data}
    />
  );
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
    </section>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>('shift-types');

  return (
    <div>
      <PageHeader title="Settings" />

      <div
        data-testid="settings-tabs"
        role="tablist"
        aria-label="Settings sections"
        className="mb-4 flex gap-1 border-b border-border"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`settings-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-t-md px-3 py-2 text-sm font-medium ${
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
            tab.id === 'shift-types' ? (
              <ShiftTypesPanel />
            ) : tab.id === 'coverage' ? (
              <CoverageTab />
            ) : tab.id === 'acuity' ? (
              <AcuityPanel />
            ) : tab.id === 'rules' ? (
              <RulesPanel />
            ) : tab.id === 'pay' ? (
              <PayPanel />
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
