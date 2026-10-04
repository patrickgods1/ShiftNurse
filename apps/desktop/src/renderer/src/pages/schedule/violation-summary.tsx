/**
 * The headline compliance readout above the grid. A manager should be able to tell "is this
 * schedule legal" without scanning 42 columns of badges — that's what the hard/soft counts are
 * for — and drill into specifics (the list under the status row) without leaving the page.
 */

import { ALL_RULES, type EvaluationResult, type Violation } from '@shiftnurse/core';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { formatDate } from '../../format.js';
import { violationKey } from './grid-utils.js';
import { PreviewTag } from './preview-tag.js';
import type { StatusItem } from './status-row.js';
import { type ValidationStatus, violationReadout } from './violation-readout.js';

// Only rules in the registry have a card in Settings › Rules to land on.
const CONFIGURABLE_RULE_IDS: ReadonlySet<string> = new Set(ALL_RULES.map((r) => r.id));

const TONE_OF = {
  'text-success': 'ok',
  'text-warn': 'warn',
  'text-danger': 'danger',
  'text-text-muted': 'muted',
} as const;

interface ViolationPillProps {
  status: ValidationStatus;
  result: EvaluationResult | undefined;
  /** The previewed variation's name, when the result is that variation's. */
  previewLabel?: string | undefined;
}

export function violationPill({ status, result, previewLabel }: ViolationPillProps): StatusItem {
  const { label, tone } = violationReadout(status, result);
  const count = status === 'success' && result ? result.violations.length : 0;
  return {
    id: 'violations',
    testId: 'violation-summary',
    tone: TONE_OF[tone],
    label,
    previewTag: <PreviewTag label={previewLabel} />,
    detail: count > 0 && result ? <ViolationList violations={result.violations} /> : undefined,
    isAlert: status === 'error',
  };
}

function ViolationList({ violations }: { violations: readonly Violation[] }) {
  // Hard-first, so the most urgent problems are always at the top of an open list.
  const sorted = useMemo(
    () =>
      [...violations].sort((a, b) => {
        if (a.severity === b.severity) return 0;
        return a.severity === 'hard' ? -1 : 1;
      }),
    [violations],
  );

  return (
    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
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
            <span className="text-text-muted"> ({violation.dates.map(formatDate).join(', ')})</span>
          ) : null}
          {CONFIGURABLE_RULE_IDS.has(violation.ruleId) ? (
            <Link
              to="/settings"
              search={{ tab: 'rules', rule: violation.ruleId }}
              className="ml-2 text-accent underline underline-offset-2 hover:no-underline"
            >
              Change this rule
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
