/**
 * The headline compliance readout above the grid. A manager should be able to tell "is this
 * schedule legal" without scanning 42 columns of badges — that's what the hard/soft counts are
 * for — and drill into specifics ("Show list") without leaving the page.
 */

import type { EvaluationResult } from '@shiftnurse/core';
import { useMemo, useState } from 'react';
import { formatDate } from '../../format.js';
import { violationKey } from './grid-utils.js';
import { type ValidationStatus, violationReadout } from './violation-readout.js';

interface ViolationSummaryProps {
  status: ValidationStatus;
  result: EvaluationResult | undefined;
}

export function ViolationSummary({ status, result }: ViolationSummaryProps) {
  const [open, setOpen] = useState(false);
  const { label, tone } = violationReadout(status, result);
  const count = status === 'success' && result ? result.violations.length : 0;

  // Hard-first, so the most urgent problems are always at the top of an open list.
  const sorted = useMemo(() => {
    if (!result) return [];
    return [...result.violations].sort((a, b) => {
      if (a.severity === b.severity) return 0;
      return a.severity === 'hard' ? -1 : 1;
    });
  }, [result]);

  return (
    <div
      data-testid="violation-summary"
      className="mb-3 rounded-md border border-border bg-surface px-3 py-2 text-sm"
    >
      <div className="flex items-center justify-between gap-3">
        {/* Polite, not assertive: it changes after every grid edit. An error is an alert. */}
        <p
          className={`font-medium ${tone}`}
          role={status === 'error' ? 'alert' : undefined}
          aria-live={status === 'error' ? undefined : 'polite'}
        >
          {label}
        </p>
        {count > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-xs text-accent underline underline-offset-2 hover:no-underline"
          >
            {open ? 'Hide list' : 'Show list'}
          </button>
        ) : null}
      </div>
      {open && count > 0 ? (
        <ul className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-border pt-2">
          {sorted.map((violation) => (
            // Violations have no id of their own; the rule plus the entities it names is
            // stable and unique enough within one validation result to key a render on.
            <li
              key={violationKey(violation)}
              className={`text-xs ${violation.severity === 'hard' ? 'text-danger' : 'text-warn'}`}
            >
              <span className="font-medium">{violation.severity === 'hard' ? 'Hard' : 'Soft'}</span>
              {' — '}
              {violation.message}
              {violation.dates.length > 0 ? (
                <span className="text-text-muted">
                  {' '}
                  ({violation.dates.map(formatDate).join(', ')})
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
