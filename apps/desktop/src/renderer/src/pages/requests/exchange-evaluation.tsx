/** How a proposed exchange lands: the verdict pill and each nurse's before-and-after. */

import type { ExchangeEvaluation, Id, Nurse } from '@shiftnurse/core';
import { formatDollars, formatHours, formatSignedDollars } from '../../money.js';
import { nurseLabel } from './decide-dialog.js';

const VERDICT_STYLE: Record<ExchangeEvaluation['verdict'], string> = {
  ok: 'bg-success/15 text-success',
  warn: 'bg-warn/15 text-warn',
  blocked: 'bg-danger/15 text-danger',
};

export function VerdictPill({ verdict }: { verdict: ExchangeEvaluation['verdict'] }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${VERDICT_STYLE[verdict]}`}
    >
      {verdict}
    </span>
  );
}

export function EvaluationPanel({
  evaluation,
  nursesById,
}: {
  evaluation: ExchangeEvaluation;
  nursesById: ReadonlyMap<Id, Nurse>;
}) {
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <VerdictPill verdict={evaluation.verdict} />
        {evaluation.verdict === 'ok' ? (
          <span className="text-sm text-text-muted">No hard breach, no warning.</span>
        ) : null}
      </div>
      {evaluation.blockers.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-sm text-danger">
          {evaluation.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
      {evaluation.warnings.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-sm text-warn">
          {evaluation.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <SideImpact
          title={`Requesting · ${nurseLabel(nursesById, evaluation.requesting.nurseId)}`}
          side={evaluation.requesting}
        />
        <SideImpact
          title={`Counterparty · ${nurseLabel(nursesById, evaluation.counterparty.nurseId)}`}
          side={evaluation.counterparty}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-md border border-border p-2">
          <p className="text-xs text-text-muted">Unit fairness</p>
          <p className="mt-1">
            {evaluation.fairness.unitScoreBefore.toFixed(0)} →{' '}
            {evaluation.fairness.unitScoreAfter.toFixed(0)}
          </p>
        </div>
        <div className="rounded-md border border-border p-2">
          <p className="text-xs text-text-muted">Unit cost</p>
          <p className="mt-1">
            {formatDollars(evaluation.cost.dollarsBefore)} →{' '}
            {formatDollars(evaluation.cost.dollarsAfter)} (
            {formatSignedDollars(evaluation.cost.delta)})
          </p>
        </div>
      </div>
    </div>
  );
}

function SideImpact({ title, side }: { title: string; side: ExchangeEvaluation['requesting'] }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-xs text-text-muted">{title}</p>
      <p className="mt-1">
        {formatHours(side.hoursBefore)} → {formatHours(side.hoursAfter)}
      </p>
      <p className="text-xs text-text-muted">
        Fairness {side.fairnessBefore.toFixed(0)} → {side.fairnessAfter.toFixed(0)} · Cost{' '}
        {formatDollars(side.dollarsBefore)} → {formatDollars(side.dollarsAfter)}
      </p>
      {side.hardViolations.length > 0 ? (
        <p className="mt-1 text-danger">{side.hardViolations.length} hard violation(s)</p>
      ) : null}
    </div>
  );
}
