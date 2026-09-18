/**
 * The unit's nurse roster: who's on staff, their employment terms, and their flags. This is
 * the entry point for everything roster-related — adding/editing nurses, importing/exporting
 * CSVs, and drilling into a nurse's credentials and preferences via the detail drawer.
 */

import type { Id, Nurse } from '@shiftnurse/core';
import { useMemo, useState } from 'react';
import { useExportRosterToFile, useNurses } from '../api.js';
import { AsyncState } from '../components/async-state.js';
import { type Column, DataTable } from '../components/data-table.js';
import { PageHeader } from '../components/page-header.js';
import { formatDate } from '../format.js';
import { useUnit } from '../unit-context.js';
import { ImportDialog } from './roster/import-dialog.js';
import { NurseDetail } from './roster/nurse-detail.js';
import { NurseFormDialog } from './roster/nurse-form-dialog.js';

const EMPLOYMENT_LABELS: Record<Nurse['employmentType'], string> = {
  full_time: 'Full time',
  part_time: 'Part time',
  per_diem: 'Per diem',
  agency: 'Agency',
};

function matchesSearch(nurse: Nurse, term: string): boolean {
  const haystack = `${nurse.firstName} ${nurse.lastName} ${nurse.employeeId}`.toLowerCase();
  return haystack.includes(term);
}

export default function RosterPage() {
  const unit = useUnit();
  const nursesQuery = useNurses(unit.id);
  const exportRoster = useExportRosterToFile();

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
        render: (nurse) => EMPLOYMENT_LABELS[nurse.employmentType],
        sortValue: (nurse) => nurse.employmentType,
      },
      {
        key: 'fte',
        header: 'FTE',
        render: (nurse) => nurse.fte.toFixed(2),
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
          return flags.length > 0 ? flags.join(', ') : '—';
        },
      },
    ],
    [],
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
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg"
            >
              Import CSV
            </button>
            <button
              type="button"
              onClick={() => exportRoster.mutate(unit.id)}
              disabled={exportRoster.isPending}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-text hover:bg-bg
                disabled:opacity-60"
            >
              {exportRoster.isPending ? 'Exporting…' : 'Export CSV'}
            </button>
            <button
              type="button"
              data-testid="roster-add"
              onClick={() => setFormTarget('new')}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
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
            columns={columns}
            rows={filtered}
            rowKey={(nurse) => nurse.id}
            emptyLabel="No nurses match."
            onRowClick={(nurse) => setSelectedNurseId(nurse.id)}
          />
        </div>
      )}

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
