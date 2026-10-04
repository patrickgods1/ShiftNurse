/**
 * The unit's nurse roster: who's on staff, their employment terms, and their flags. This is
 * the entry point for everything roster-related — adding/editing nurses, importing/exporting
 * CSVs, and drilling into a nurse's credentials and preferences via the detail drawer.
 */

import type { Id, Nurse } from '@shiftnurse/core';
import { EMPLOYMENT_TYPE_LABELS } from '@shiftnurse/core';
import { useMemo, useState } from 'react';
import { useDashboard, useExportRosterToFile, useNurses } from '../api.js';
import { AsyncState } from '../components/async-state.js';
import { type Column, DataTable } from '../components/data-table.js';
import { PageHeader } from '../components/page-header.js';
import { PRIMARY, SECONDARY } from '../components/ui.js';
import { daysFromToday, formatDate, fteLabel } from '../format.js';
import { useUnit } from '../unit-context.js';
import { CredentialBadge } from './roster/credential-badge.js';
import { ImportDialog } from './roster/import-dialog.js';
import { IncompatibilitySection } from './roster/incompatibility.js';
import { NurseDetail } from './roster/nurse-detail.js';
import { NurseFormDialog } from './roster/nurse-form-dialog.js';

function matchesSearch(nurse: Nurse, term: string): boolean {
  const haystack = `${nurse.firstName} ${nurse.lastName} ${nurse.employeeId}`.toLowerCase();
  return haystack.includes(term);
}

export default function RosterPage() {
  const unit = useUnit();
  const nursesQuery = useNurses(unit.id);
  const exportRoster = useExportRosterToFile();
  // The dashboard's credential lists are already the unit's authority on who has lapsed (a
  // renewal cleared) and who is inside the 90-day window; the badge only narrows to 30 days.
  const dashboardQuery = useDashboard(unit.id);
  const lapsedNurseIds = useMemo(
    () => new Set((dashboardQuery.data?.lapsedCredentials ?? []).map((c) => c.nurse.id)),
    [dashboardQuery.data],
  );
  const soonNurseIds = useMemo(
    () =>
      new Set(
        (dashboardQuery.data?.expiringCredentials ?? [])
          .filter(
            (c) =>
              c.nurseCredential.expiresOn !== undefined &&
              daysFromToday(c.nurseCredential.expiresOn) <= 30,
          )
          .map((c) => c.nurse.id),
      ),
    [dashboardQuery.data],
  );

  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [formTarget, setFormTarget] = useState<'new' | Nurse | undefined>(undefined);
  const [selectedNurseId, setSelectedNurseId] = useState<Id | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);

  const columns: Column<Nurse>[] = useMemo(
    () => [
      {
        key: 'name',
        header: 'Name',
        render: (nurse) => `${nurse.lastName}, ${nurse.firstName}`,
        sortValue: (nurse) => `${nurse.lastName}, ${nurse.firstName}`.toLowerCase(),
      },
      {
        key: 'employeeId',
        header: 'Employee ID',
        render: (nurse) => nurse.employeeId,
        sortValue: (nurse) => nurse.employeeId,
      },
      {
        key: 'role',
        header: 'Role',
        render: (nurse) => nurse.role,
        sortValue: (nurse) => nurse.role,
      },
      {
        key: 'employmentType',
        header: 'Employment',
        render: (nurse) => EMPLOYMENT_TYPE_LABELS[nurse.employmentType],
        sortValue: (nurse) => nurse.employmentType,
      },
      {
        key: 'fte',
        header: 'FTE',
        render: (nurse) => fteLabel(nurse),
        sortValue: (nurse) => nurse.fte,
      },
      {
        key: 'seniorityDate',
        header: 'Seniority date',
        render: (nurse) => formatDate(nurse.seniorityDate),
        sortValue: (nurse) => nurse.seniorityDate,
      },
      {
        key: 'flags',
        header: 'Flags',
        render: (nurse) => {
          const flags: string[] = [];
          if (nurse.isChargeEligible) flags.push('Charge');
          if (nurse.isNovice) flags.push('Novice');
          if (!nurse.active) flags.push('Inactive');
          const badges = (
            <>
              {lapsedNurseIds.has(nurse.id) ? <CredentialBadge standing="lapsed" /> : null}
              {soonNurseIds.has(nurse.id) ? <CredentialBadge standing="soon" /> : null}
            </>
          );
          if (flags.length === 0 && !lapsedNurseIds.has(nurse.id) && !soonNurseIds.has(nurse.id)) {
            return '—';
          }
          return (
            <span className="flex flex-wrap items-center gap-1">
              {flags.length > 0 ? <span>{flags.join(', ')}</span> : null}
              {badges}
            </span>
          );
        },
      },
    ],
    [lapsedNurseIds, soonNurseIds],
  );

  const filtered = (nursesQuery.data ?? []).filter((nurse) => {
    if (!showInactive && !nurse.active) return false;
    if (search.trim() === '') return true;
    return matchesSearch(nurse, search.trim().toLowerCase());
  });

  return (
    <div>
      <PageHeader
        title="Roster"
        description="Nurses assigned to this unit"
        actions={
          <>
            <button type="button" onClick={() => setImportOpen(true)} className={SECONDARY}>
              Import CSV
            </button>
            <button
              type="button"
              onClick={() => exportRoster.mutate(unit.id)}
              disabled={exportRoster.isPending}
              className={SECONDARY}
            >
              {exportRoster.isPending ? 'Exporting…' : 'Export CSV'}
            </button>
            <button
              type="button"
              data-testid="roster-add"
              onClick={() => setFormTarget('new')}
              className={PRIMARY}
            >
              Add nurse
            </button>
          </>
        }
      />

      <div className="mb-4 flex items-center gap-4">
        <label className="flex-1">
          <span className="sr-only">Search nurses</span>
          <input
            type="search"
            placeholder="Search by name or employee ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full max-w-xs rounded-md border border-border bg-surface px-3 py-1.5 text-sm
              text-text"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      {nursesQuery.isPending ? (
        <AsyncState status="loading" label="Loading roster" />
      ) : nursesQuery.isError ? (
        <AsyncState status="error" label="Could not load roster" error={nursesQuery.error} />
      ) : (
        <div data-testid="roster-table">
          <DataTable
            initialSortKey="name"
            columns={columns}
            rows={filtered}
            rowKey={(nurse) => nurse.id}
            emptyLabel="No nurses match."
            onRowClick={(nurse) => setSelectedNurseId(nurse.id)}
          />
        </div>
      )}

      {nursesQuery.data ? (
        <IncompatibilitySection unitId={unit.id} nurses={nursesQuery.data} />
      ) : null}

      <NurseFormDialog
        open={formTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setFormTarget(undefined);
        }}
        unitId={unit.id}
        payPeriodDays={unit.payPeriodDays}
        nurse={formTarget === 'new' ? undefined : formTarget}
      />

      {selectedNurseId !== undefined ? (
        <NurseDetail
          nurseId={selectedNurseId}
          onClose={() => setSelectedNurseId(undefined)}
          onEdit={(nurse) => setFormTarget(nurse)}
        />
      ) : null}

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} unitId={unit.id} />
    </div>
  );
}
