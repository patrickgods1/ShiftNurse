/**
 * Compliance alerts, a pill in the status row with the list opening below it: what will go wrong
 * *after* this schedule goes out — a credential lapsing mid-period, hours drifting off contract,
 * overtime weeks, shifts staffed exactly at their floor. None of these is a rule violation today,
 * which is exactly why they need their own readout: the violation summary would say "0 hard" and
 * the unit would find out on the day.
 *
 * Grouped by kind, critical first. A tight unit has a shift at exactly its ratio most days, and as
 * a flat list those dozens of "one call-off breaches it" lines buried the two credentials that
 * actually lapse mid-schedule. So each kind is a heading with a count, the ones that need action
 * open by default, and the routine ones (ratio slack) folded until asked for.
 */

import type { ComplianceAlert, ComplianceAlertKind, Id, IsoDate } from '@shiftnurse/core';
import { useState } from 'react';
import { useAlerts } from '../../api-publish.js';
import { errorMessage } from '../../components/ui.js';
import { formatDateWithWeekday } from '../../format.js';
import { PreviewTag } from './preview-tag.js';
import type { StatusItem } from './status-row.js';

interface AlertsPillProps {
  periodId: string;
  /** While a Generate variation is previewed: its alerts, judged by main, and its name. */
  preview?: { alerts: readonly ComplianceAlert[]; label: string } | undefined;
  /** Scroll the grid to what an alert is about: its day, and its nurse and shifts when named. */
  onShow?: (target: AlertTarget) => void;
  /** Already published: the critical ones are to act on now, not "before publishing". */
  published?: boolean;
}

export interface AlertTarget {
  date: IsoDate;
  nurseId?: Id | undefined;
  assignmentIds: readonly Id[];
}

const KINDS: { kind: ComplianceAlertKind; title: string; hint: string }[] = [
  {
    kind: 'credential_expiry',
    title: 'Credentials expiring',
    hint: 'Renew them, or move the shifts after the expiry date.',
  },
  {
    kind: 'overtime',
    title: 'Overtime',
    hint: 'Weeks where a nurse goes past the overtime threshold.',
  },
  {
    kind: 'hours_drift',
    title: 'Hours off contract',
    hint: 'Nurses scheduled noticeably over or under their contracted hours.',
  },
  {
    kind: 'late_posting',
    title: 'Late posting',
    hint: "Publishing today would give staff less notice than the unit's posting rule. Publish sooner, or change the rule in Settings › Unit.",
  },
  {
    kind: 'per_diem_commitment',
    title: 'Per-diem commitment',
    hint: 'Per-diem nurses below the weekend or holiday shifts their contract asks for. Add shifts for them, or accept the shortfall.',
  },
  {
    kind: 'weekends_off_per_year',
    title: 'Weekends off per year',
    hint: 'Nurses whose weekends worked this year, with this schedule, leave fewer weekends off than the unit promises. Move a weekend shift, or accept it knowingly.',
  },
  {
    kind: 'ratio_risk',
    title: 'No slack on the ratio',
    hint: 'Shifts staffed exactly at the patient ratio: one call-off breaks it. Routine on a tight unit.',
  },
];

export function useAlertsPill({
  periodId,
  preview,
  onShow,
  published,
}: AlertsPillProps): StatusItem | undefined {
  // The draft's alerts are not asked for while a variation stands in for it.
  const alertsQuery = useAlerts(preview ? undefined : periodId);
  const alerts = preview ? preview.alerts : (alertsQuery.data ?? []);
  // A failed compliance check must not read as "no alerts" — that is the false all-clear
  // this panel exists to prevent.
  if (!preview && alertsQuery.isError) {
    return {
      id: 'alerts',
      testId: 'alerts-panel',
      tone: 'danger',
      label: `Could not check compliance alerts: ${errorMessage(alertsQuery.error)}`,
      isAlert: true,
    };
  }
  if ((!preview && alertsQuery.isPending) || alerts.length === 0) return undefined;
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const groups = groupAlerts(alerts);
  const summary = groups.map((g) => `${g.items.length} ${g.title.toLowerCase()}`).join(' · ');
  const headline =
    critical > 0 ? `${critical} to act on${published ? '' : ' before publishing'}` : '';
  return {
    id: 'alerts',
    testId: 'alerts-panel',
    tone: critical > 0 ? 'danger' : 'warn',
    label: headline || `${alerts.length} alert${alerts.length === 1 ? '' : 's'}`,
    previewTag: <PreviewTag label={preview?.label} />,
    title: summary,
    detail: <AlertsDetail groups={groups} summary={summary} onShow={onShow} />,
  };
}

function groupAlerts(alerts: readonly ComplianceAlert[]) {
  return (
    KINDS.map((k) => ({ ...k, items: alerts.filter((a) => a.kind === k.kind) }))
      .filter((g) => g.items.length > 0)
      // Anything critical first, then in the order above.
      .sort(
        (a, b) =>
          Number(b.items.some((i) => i.severity === 'critical')) -
          Number(a.items.some((i) => i.severity === 'critical')),
      )
  );
}

function AlertsDetail({
  groups,
  summary,
  onShow,
}: {
  groups: ReturnType<typeof groupAlerts>;
  summary: string;
  onShow?: ((target: AlertTarget) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<ComplianceAlertKind>>(new Set());

  return (
    <>
      <p className="mb-2 text-xs text-text-muted">{summary}</p>
      <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
        {groups.map((group) => {
          const hasCritical = group.items.some((i) => i.severity === 'critical');
          const isOpen = expanded.has(group.kind) || group.kind !== 'ratio_risk';
          return (
            <section key={group.kind} data-testid={`alerts-${group.kind}`}>
              <div className="flex items-baseline justify-between gap-3">
                <h3
                  className={`text-xs font-semibold ${hasCritical ? 'text-danger' : 'text-text'}`}
                >
                  {group.title} ({group.items.length})
                </h3>
                {group.kind === 'ratio_risk' ? (
                  <button
                    type="button"
                    className="text-xs text-accent underline underline-offset-2"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.kind)) next.delete(group.kind);
                        else next.add(group.kind);
                        return next;
                      })
                    }
                  >
                    {isOpen ? 'Fold' : 'Show each shift'}
                  </button>
                ) : null}
              </div>
              <p className="text-xs text-text-muted">{group.hint}</p>
              {isOpen ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {group.items.map((alert) => (
                    <li
                      key={`${alert.kind}:${alert.nurseId ?? ''}:${alert.date ?? ''}:${alert.shiftTypeId ?? ''}:${alert.message}`}
                      className={`flex items-baseline justify-between gap-3 text-xs ${
                        alert.severity === 'critical' ? 'text-danger' : 'text-text'
                      }`}
                    >
                      <span>{alert.message}</span>
                      {alert.date && onShow ? (
                        <button
                          type="button"
                          onClick={() =>
                            onShow({
                              date: alert.date!,
                              nurseId: alert.nurseId,
                              assignmentIds: alert.assignmentIds,
                            })
                          }
                          className="shrink-0 text-accent underline underline-offset-2"
                          aria-label={`Show ${formatDateWithWeekday(alert.date)} on the grid`}
                        >
                          Show on grid
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
    </>
  );
}
