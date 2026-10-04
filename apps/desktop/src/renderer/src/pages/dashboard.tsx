/**
 * The manager's landing page: what needs attention today. Every number here is something a
 * unit manager checks first thing — nobody wants to click through five screens to find out a
 * credential lapsed last week.
 */

import type { DashboardSummary, ExpiringCredentialView } from '@shared/api.js';
import { Link } from '@tanstack/react-router';
import { useDashboard, useNurses, useShiftTypes } from '../api.js';
import { useCoverage } from '../api-config.js';
import { AsyncState } from '../components/async-state.js';
import { HppdSummary } from '../components/hppd-summary.js';
import { PageHeader } from '../components/page-header.js';
import { StatCard } from '../components/stat-card.js';
import { daysFromToday, formatDate, listName, periodLabel } from '../format.js';
import { useUnitId } from '../unit-context.js';
import { CostPanel } from './dashboard/cost-panel.js';

function credentialTone(expiresOn: string | undefined): 'neutral' | 'warn' | 'danger' {
  if (expiresOn === undefined) return 'neutral';
  const days = daysFromToday(expiresOn);
  if (days <= 30) return 'danger';
  if (days <= 90) return 'warn';
  return 'neutral';
}

/** Expiring credentials inside a month: the one definition the tile and Next steps share. */
function dueWithin30Days(rows: ExpiringCredentialView[]): number {
  return rows.filter(
    (c) =>
      c.nurseCredential.expiresOn !== undefined && daysFromToday(c.nurseCredential.expiresOn) <= 30,
  ).length;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
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
          <p className="mt-1 font-medium text-text">{periodLabel(period)}</p>
          <p className="mt-1 text-xs uppercase tracking-wide text-text-muted">{period.status}</p>
        </>
      )}
    </div>
  );
}

function ExpiringCredentialsTable({
  lapsed,
  expiring,
}: {
  lapsed: ExpiringCredentialView[];
  expiring: ExpiringCredentialView[];
}) {
  if (lapsed.length === 0 && expiring.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        No credentials have lapsed or expire in the next 90 days.
      </p>
    );
  }
  const rows = [
    ...lapsed.map((row) => ({ row, isLapsed: true })),
    ...expiring.map((row) => ({ row, isLapsed: false })),
  ];
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
          {rows.map(({ row, isLapsed }) => {
            const tone = isLapsed ? 'danger' : credentialTone(row.nurseCredential.expiresOn);
            const toneClass =
              tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-text';
            return (
              <tr key={row.nurseCredential.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2 text-text">{listName(row.nurse)}</td>
                <td className="px-3 py-2 text-text">{row.credential.name}</td>
                <td className={`px-3 py-2 font-medium ${toneClass}`}>
                  {row.nurseCredential.expiresOn === undefined
                    ? '—'
                    : isLapsed
                      ? `Lapsed ${formatDate(row.nurseCredential.expiresOn)}`
                      : formatDate(row.nurseCredential.expiresOn)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Hover and focus for the stat cards that open the page where the number is acted on. */
const CARD_LINK =
  'block rounded-md hover:ring-2 hover:ring-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

/**
 * What to do next, in the order a manager would: cover today, decide requests, then build or
 * publish the next schedule, then chase credentials. Nothing to do reads as such.
 */
function NextSteps({
  summary,
  shiftTypes,
  coverageRows,
}: {
  summary: DashboardSummary;
  shiftTypes: number;
  coverageRows: number;
}) {
  const soon = dueWithin30Days(summary.expiringCredentials);
  const lapsed = summary.lapsedCredentials.length;
  const steps: {
    text: string;
    to?: '/today' | '/requests' | '/schedule' | '/roster' | '/settings';
    urgent?: boolean;
  }[] = [];
  // A unit that cannot be scheduled yet: what it is missing comes first.
  if (shiftTypes === 0) {
    steps.push({
      text: 'Add the shifts your unit works (Settings › Shift types)',
      to: '/settings',
    });
  } else if (coverageRows === 0) {
    steps.push({
      text: 'Set the staffing floors for each shift (Settings › Coverage floors)',
      to: '/settings',
    });
  }
  if (summary.activeNurses === 0) {
    steps.push({ text: 'Add your nurses, or import them from a spreadsheet', to: '/roster' });
  }
  if (!summary.currentDraft && shiftTypes > 0 && summary.activeNurses > 0) {
    steps.push({ text: 'Create your next schedule period', to: '/schedule' });
  }
  if (summary.openCallOffs > 0) {
    steps.push({
      text: `Cover ${summary.openCallOffs} open call-off${summary.openCallOffs === 1 ? '' : 's'}`,
      to: '/today',
      urgent: true,
    });
  }
  if (summary.pendingTimeOff > 0) {
    steps.push({
      text: `Decide ${summary.pendingTimeOff} time-off request${summary.pendingTimeOff === 1 ? '' : 's'}`,
      to: '/requests',
    });
  }
  if (summary.currentDraft) {
    steps.push({
      text:
        summary.draftShifts === 0
          ? `Generate the ${periodLabel(summary.currentDraft)} schedule`
          : `Review and publish the ${periodLabel(summary.currentDraft)} schedule`,
      to: '/schedule',
    });
  }
  if (lapsed > 0) {
    steps.push({
      text: `${lapsed} ${plural(lapsed, 'credential has', 'credentials have')} lapsed — Roster`,
      to: '/roster',
      urgent: true,
    });
  }
  if (soon > 0) {
    steps.push({
      text: `Follow up ${soon} ${plural(soon, 'credential', 'credentials')} expiring within 30 days`,
    });
  }
  return (
    <section
      data-testid="next-steps"
      className="mb-4 rounded-md border border-border bg-surface p-4"
    >
      <h2 className="text-sm font-semibold text-text">Next steps</h2>
      {steps.length === 0 ? (
        <p className="mt-1 text-sm text-text-muted">Nothing waiting on you right now.</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-1 text-sm">
          {steps.map((step, i) => (
            <li key={step.text} className="flex items-baseline gap-2">
              <span className="text-text-muted">{i + 1}.</span>
              {step.to ? (
                <Link
                  to={step.to}
                  className={`underline underline-offset-2 ${step.urgent ? 'text-danger' : 'text-accent'}`}
                >
                  {step.text}
                </Link>
              ) : (
                <span className="text-text">{step.text}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function DashboardPage() {
  const unitId = useUnitId();
  const dashboardQuery = useDashboard(unitId);
  const nursesQuery = useNurses(unitId);
  const shiftTypesQuery = useShiftTypes(unitId);
  const coverageQuery = useCoverage(unitId);

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
  const lapsedCount = summary.lapsedCredentials.length;
  const soonCount = dueWithin30Days(summary.expiringCredentials);
  const credentialTotal = lapsedCount + summary.expiringCredentials.length;

  return (
    <div>
      <PageHeader title="Dashboard" description={`As of ${formatDate(summary.today)}`} />

      <NextSteps
        summary={summary}
        shiftTypes={(shiftTypesQuery.data ?? []).filter((s) => s.active).length}
        coverageRows={(coverageQuery.data ?? []).length}
      />

      <div className="grid grid-cols-4 gap-4">
        <Link to="/roster" aria-label="Active nurses — open Roster" className={CARD_LINK}>
          <StatCard label="Active nurses" value={summary.activeNurses} />
        </Link>
        <Link to="/requests" aria-label="Pending time off — open Requests" className={CARD_LINK}>
          <StatCard
            label="Pending time off"
            value={summary.pendingTimeOff}
            tone={summary.pendingTimeOff > 0 ? 'warn' : 'neutral'}
          />
        </Link>
        <Link to="/today" aria-label="Open call-offs — open Today" className={CARD_LINK}>
          <StatCard
            label="Open call-offs"
            value={summary.openCallOffs}
            tone={summary.openCallOffs > 0 ? 'danger' : 'neutral'}
          />
        </Link>
        <button
          type="button"
          aria-label="Credentials lapsed or expiring — jump to the list"
          className={`${CARD_LINK} text-left`}
          onClick={() =>
            document
              .getElementById('expiring-credentials')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        >
          <StatCard
            label="Credentials lapsed or expiring (90 days)"
            value={credentialTotal}
            detail={`${lapsedCount} lapsed · ${soonCount} within 30 days`}
            tone={
              lapsedCount > 0 || soonCount > 0 ? 'danger' : credentialTotal > 0 ? 'warn' : 'neutral'
            }
          />
        </button>
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
          <>
            <CostPanel period={costPeriod} nurses={nursesQuery.data ?? []} />
            <div className="mt-4 max-w-xl">
              <HppdSummary
                periodId={costPeriod.id}
                title={`Scheduled HPPD, ${costPeriod.status === 'draft' ? 'current draft' : 'latest published'}`}
              />
            </div>
          </>
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
                  {[...group.nurses]
                    .sort((a, b) => a.lastName.localeCompare(b.lastName))
                    .map((nurse) => (
                      <li key={nurse.id}>{listName(nurse)}</li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-6" id="expiring-credentials">
        <h2 className="mb-2 text-sm font-semibold text-text">Lapsed and expiring credentials</h2>
        <ExpiringCredentialsTable
          lapsed={summary.lapsedCredentials}
          expiring={summary.expiringCredentials}
        />
      </div>
    </div>
  );
}
