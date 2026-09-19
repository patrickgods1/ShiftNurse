/**
 * Compliance alerts under the cost strip: what will go wrong *after* this schedule goes out —
 * a credential lapsing mid-period, hours drifting off contract, overtime weeks, shifts staffed
 * exactly at their floor. None of these is a rule violation today, which is exactly why they
 * need their own readout: the violation summary would say "0 hard" and the unit would find
 * out on the day.
 */

import { useState } from 'react';
import { useAlerts } from '../../api-publish.js';

interface AlertsPanelProps {
  periodId: string;
}

export function AlertsPanel({ periodId }: AlertsPanelProps) {
  const [open, setOpen] = useState(false);
  const alertsQuery = useAlerts(periodId);
  const alerts = alertsQuery.data ?? [];
  if (alertsQuery.isPending || alerts.length === 0) return null;
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const tone = critical > 0 ? 'text-danger' : 'text-warn';

  return (
    <div
      data-testid="alerts-panel"
      className="mb-3 rounded-md border border-border bg-surface px-3 py-2 text-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <p className={`font-medium ${tone}`}>
          {alerts.length} compliance alert{alerts.length === 1 ? '' : 's'}
          {critical > 0 ? ` · ${critical} critical` : ''}
        </p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-xs text-accent underline underline-offset-2 hover:no-underline"
        >
          {open ? 'Hide list' : 'Show list'}
        </button>
      </div>
      {open ? (
        <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-border pt-2">
          {alerts.map((alert) => (
            <li
              key={`${alert.kind}:${alert.nurseId ?? ''}:${alert.date ?? ''}:${alert.shiftTypeId ?? ''}`}
              className={`text-xs ${alert.severity === 'critical' ? 'text-danger' : 'text-warn'}`}
            >
              <span className="font-medium capitalize">{alert.kind.replace('_', ' ')}</span>
              {' — '}
              {alert.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
