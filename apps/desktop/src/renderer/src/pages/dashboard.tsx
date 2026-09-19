/**
 * The manager's landing page: what needs attention today. Every number here is something a
 * unit manager checks first thing — nobody wants to click through five screens to find out a
 * credential lapsed last week.
 */

import type { ExpiringCredentialView } from '@shared/api.js';
import { Link } from '@tanstack/react-router';
import { useDashboard, useNurses } from '../api.js';
import { AsyncState } from '../components/async-state.js';
import { PageHeader } from '../components/page-header.js';
import { StatCard } from '../components/stat-card.js';
import { daysFromToday, formatDate } from '../format.js';
import { useUnitId } from '../unit-context.js';
import { CostPanel } from './dashboard/cost-panel.js';

function credentialTone(expiresOn: string | undefined): 'neutral' | 'warn' | 'danger' {
  if (expiresOn === undefined) return 'neutral';
  const days = daysFromToday(expiresOn);
  if (days <= 30) return 'danger';
  if (days <= 90) return 'warn';
  return 'neutral';
}

function PeriodCard({
  title,
  period,
}: {
  title: string;
  period: { name: string; startDate: string; endDate: string; status: string } | undefined;
}) {
  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <p className="text-sm text-text-muted">{title}</p>
      {period === undefined ? (
        <p className="mt-1 text-text-muted">None yet</p>
      ) : (
        <>
          <p className="mt-1 font-medium text-text">{period.name}</p>
          <p className="text-sm text-text-muted">
            {formatDate(period.startDate)} – {formatDate(period.endDate)}
          </p>
          <p className="mt-1 text-xs uppercase tracking-wide text-text-muted">{period.status}</p>
        </>
      )}
    </div>
  );
}

function ExpiringCredentialsTable({ rows }: { rows: ExpiringCredentialView[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-text-muted">No credentials expiring in the next 90 days.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Nurse
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Credential
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Expires
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const tone = credentialTone(row.nurseCredential.expiresOn);
            const toneClass =
              tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-text';
            return (
              <tr key={row.nurseCredential.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 text-text">
                  {row.nurse.firstName} {row.nurse.lastName}
                </td>
                <td className="px-3 py-2 text-text">{row.credential.name}</td>
                <td className={`px-3 py-2 font-medium ${toneClass}`}>
                  {row.nurseCredential.expiresOn !== undefined
                    ? formatDate(row.nurseCredential.expiresOn)
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function DashboardPage() {
  const unitId = useUnitId();
  const dashboardQuery = useDashboard(unitId);
  const nursesQuery = useNurses(unitId);

  if (dashboardQuery.isPending) {
    return <AsyncState status="loading" label="Loading dashboard" />;
  }
  if (dashboardQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load dashboard" error={dashboardQuery.error} />
    );
  }
  const summary = dashboardQuery.data;
  // Price what the manager is working on; fall back to the last thing that went out.
  const costPeriod = summary.currentDraft ?? summary.latestPublished;

  return (
    <div>
      <PageHeader title="Dashboard" description={`As of ${formatDate(summary.today)}`} />

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Active nurses" value={summary.activeNurses} />
        <Link to="/requests" aria-label="Pending time off — open Requests" className="block">
          <StatCard
            label="Pending time off"
            value={summary.pendingTimeOff}
            tone={summary.pendingTimeOff > 0 ? 'warn' : 'neutral'}
          />
        </Link>
        <StatCard
          label="Open call-offs"
          value={summary.openCallOffs}
          tone={summary.openCallOffs > 0 ? 'danger' : 'neutral'}
        />
        <StatCard
          label="Credentials expiring"
          value={summary.expiringCredentials.length}
          tone={summary.expiringCredentials.length > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <PeriodCard title="Current draft" period={summary.currentDraft} />
        <PeriodCard title="Latest published" period={summary.latestPublished} />
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-text">Cost</h2>
        {costPeriod === undefined ? (
          <p className="text-sm text-text-muted">No scheduling period to price yet.</p>
        ) : (
          <CostPanel period={costPeriod} nurses={nursesQuery.data ?? []} />
        )}
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-text">Today on shift</h2>
        {summary.todayOnShift.length === 0 ? (
          <p className="text-sm text-text-muted">No published schedule covers today.</p>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {summary.todayOnShift.map((group) => (
              <div
                key={group.shiftType.id}
                className="rounded-md border border-border bg-surface p-4"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: group.shiftType.color }}
                  />
                  <span className="font-medium text-text">{group.shiftType.abbreviation}</span>
                  <span className="text-sm text-text-muted">{group.shiftType.name}</span>
                </div>
                <ul className="space-y-1 text-sm text-text">
                  {group.nurses.map((nurse) => (
                    <li key={nurse.id}>
                      {nurse.firstName} {nurse.lastName}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold text-text">Expiring credentials</h2>
        <ExpiringCredentialsTable rows={summary.expiringCredentials} />
      </div>
    </div>
  );
}
