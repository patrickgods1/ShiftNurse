/**
 * The period's conflicts, worst first, and for the selected one its ranked ways out.
 *
 * Each card carries the three deltas the roadmap insists on — coverage, fairness, dollars —
 * because a resolution that closes the gap by handing the same nurse her fourth weekend, or by
 * paying overtime nobody budgeted, is a decision the manager has to make knowingly. Accepting
 * the shortfall is always offered, always last and always muted: it is a legitimate choice,
 * but it must never look like the easy one.
 */

import type {
  AutoResolvePolicy,
  Conflict,
  ConflictReport,
  Id,
  Nurse,
  Resolution,
  SchedulePeriod,
} from '@shiftnurse/core';
import { useEffect, useState } from 'react';
import { useAutoResolve, useResolveConflict } from '../../api-requests.js';
import { StatCard } from '../../components/stat-card.js';
import { formatDateWithWeekday } from '../../format.js';
import { formatSignedDollars } from '../../money.js';
import { nurseLabel } from './decide-dialog.js';
import { ReasonDialog } from './reason-dialog.js';
import { errorMessage, PRIMARY, SECONDARY } from './ui.js';

interface ConflictsPanelProps {
  unitId: Id;
  period: SchedulePeriod;
  report: ConflictReport;
  policy: AutoResolvePolicy | undefined;
  nursesById: ReadonlyMap<Id, Nurse>;
}

const KIND_LABEL: Record<Conflict['kind'], string> = {
  understaffing: 'Understaffed',
  ratio_breach: 'Ratio breach',
  competing_time_off: 'Competing time off',
  fte: 'FTE',
  credential: 'Credential',
  budget: 'Budget',
  scheduled_on_leave: 'Rostered on approved leave',
};

export function ConflictsPanel({
  unitId,
  period,
  report,
  policy,
  nursesById,
}: ConflictsPanelProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [applying, setApplying] = useState<Resolution | undefined>(undefined);
  const resolve = useResolveConflict(unitId, period.id);
  const auto = useAutoResolve(unitId, period.id);

  // Keep the selection on a conflict that still exists after a re-analysis.
  const selected = report.conflicts.find((c) => c.id === selectedId) ?? report.conflicts[0];
  useEffect(() => {
    if (selected !== undefined && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const options = selected ? report.resolutions.filter((r) => r.conflictId === selected.id) : [];
  const ranked = [
    ...options.filter((r) => r.kind !== 'accept_shortfall'),
    ...options.filter((r) => r.kind === 'accept_shortfall'),
  ];
  const isDraft = period.status === 'draft';
  const autoEnabled = policy?.enabled === true;

  return (
    <section aria-labelledby="conflicts-heading" data-testid="conflicts-panel">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="conflicts-heading" className="text-sm font-semibold text-text">
          Conflicts · {period.name}
        </h2>
        <div className="flex items-center gap-2">
          {auto.data !== undefined ? (
            <span className="text-xs text-text-muted" data-testid="auto-resolve-result">
              {auto.data.applied.length === 0
                ? 'Nothing qualified under the policy.'
                : `Applied ${auto.data.applied.length}: ${auto.data.applied.map((r) => r.title).join('; ')}`}
            </span>
          ) : null}
          <button
            type="button"
            className={SECONDARY}
            data-testid="auto-resolve"
            disabled={!autoEnabled || !isDraft || auto.isPending}
            title={
              !autoEnabled
                ? 'Auto-resolve is off. Turn it on under Settings › Conflicts.'
                : !isDraft
                  ? 'Only a draft can be changed.'
                  : 'Apply every resolution the policy admits; each is written to the audit log.'
            }
            onClick={() => auto.mutate()}
          >
            {auto.isPending ? 'Resolving…' : 'Auto-resolve now'}
          </button>
        </div>
      </div>
      {errorMessage(auto.error) !== undefined ? (
        <p role="alert" className="mb-3 text-sm text-danger">
          {errorMessage(auto.error)}
        </p>
      ) : null}

      <div className="mb-4 grid grid-cols-3 gap-4">
        <StatCard
          label="Hard conflicts"
          value={report.summary.hard}
          tone={report.summary.hard > 0 ? 'danger' : 'neutral'}
        />
        <StatCard
          label="Soft conflicts"
          value={report.summary.soft}
          tone={report.summary.soft > 0 ? 'warn' : 'neutral'}
        />
        <StatCard
          label="Slots short of a hard minimum"
          value={report.summary.hardShortfall}
          tone={report.summary.hardShortfall > 0 ? 'danger' : 'neutral'}
        />
      </div>

      {report.conflicts.length === 0 ? (
        <p className="rounded-md border border-border bg-surface p-6 text-center text-sm text-text-muted">
          No conflicts in this period.
        </p>
      ) : (
        <div className="grid grid-cols-[minmax(16rem,2fr)_3fr] gap-4">
          <ol
            className="flex max-h-[32rem] flex-col gap-1 overflow-y-auto"
            aria-label="Conflicts, worst first"
          >
            {report.conflicts.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  aria-pressed={c.id === selected?.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full rounded-md border p-2 text-left text-sm ${
                    c.id === selected?.id
                      ? 'border-accent bg-bg'
                      : 'border-border bg-surface hover:bg-bg'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1 text-[10px] uppercase ${
                        c.severity === 'hard' ? 'bg-danger/15 text-danger' : 'bg-warn/15 text-warn'
                      }`}
                    >
                      {c.severity}
                    </span>
                    <span className="font-medium text-text">{KIND_LABEL[c.kind]}</span>
                    <span className="ml-auto text-xs text-text-muted">
                      {c.dates[0] ? formatDateWithWeekday(c.dates[0]) : ''}
                      {c.dates.length > 1 ? ` +${c.dates.length - 1}` : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-text-muted">{c.message}</p>
                </button>
              </li>
            ))}
          </ol>

          <div className="flex flex-col gap-2" data-testid="resolution-cards">
            {selected === undefined ? null : ranked.length === 0 ? (
              <p className="rounded-md border border-border bg-surface p-4 text-sm text-text-muted">
                No options were generated for this conflict.
              </p>
            ) : (
              ranked.map((r, i) => (
                <ResolutionCard
                  key={r.id}
                  rank={i + 1}
                  resolution={r}
                  nursesById={nursesById}
                  canApply={isDraft && !resolve.isPending}
                  onApply={() => {
                    resolve.reset();
                    setApplying(r);
                  }}
                />
              ))
            )}
          </div>
        </div>
      )}

      <ReasonDialog
        open={applying !== undefined}
        onOpenChange={(next) => !next && setApplying(undefined)}
        title={applying ? `Apply: ${applying.title}` : 'Apply resolution'}
        description={applying?.description}
        confirmLabel="Apply"
        pending={resolve.isPending}
        error={resolve.error}
        onConfirm={(reason) => {
          if (!applying) return;
          resolve.mutate(
            { resolution: applying, reason },
            { onSuccess: () => setApplying(undefined) },
          );
        }}
      />
    </section>
  );
}

function ResolutionCard({
  rank,
  resolution: r,
  nursesById,
  canApply,
  onApply,
}: {
  rank: number;
  resolution: Resolution;
  nursesById: ReadonlyMap<Id, Nurse>;
  canApply: boolean;
  onApply: () => void;
}) {
  const muted = r.kind === 'accept_shortfall';
  const { coverage, fairness, cost, softViolationsIntroduced } = r.impact;
  return (
    <article
      className={`rounded-md border p-3 text-sm ${
        muted ? 'border-dashed border-border bg-bg text-text-muted' : 'border-border bg-surface'
      }`}
      aria-label={`Option ${rank}: ${r.title}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={`font-medium ${muted ? '' : 'text-text'}`}>
            <span className="mr-2 text-xs text-text-muted">#{rank}</span>
            {r.title}
          </p>
          <p className="mt-1 text-xs text-text-muted">{r.description}</p>
        </div>
        <button
          type="button"
          className={muted ? SECONDARY : PRIMARY}
          disabled={!canApply}
          onClick={onApply}
        >
          {muted ? 'Accept' : 'Apply'}
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-text-muted">Coverage</dt>
          <dd
            className={
              coverage.delta < 0 ? 'text-success' : coverage.delta > 0 ? 'text-danger' : ''
            }
          >
            {coverage.delta === 0
              ? 'no change'
              : `${coverage.delta > 0 ? '+' : ''}${coverage.delta} slot${Math.abs(coverage.delta) === 1 ? '' : 's'} short`}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Fairness</dt>
          <dd
            className={fairness.delta > 0 ? 'text-success' : fairness.delta < 0 ? 'text-warn' : ''}
          >
            {fairness.delta === 0
              ? 'no change'
              : `${fairness.delta > 0 ? '+' : ''}${fairness.delta.toFixed(1)} pts`}
            {fairness.affected.length > 0 ? (
              <span className="block text-text-muted">
                {fairness.affected
                  .map(
                    (a) =>
                      `${nurseLabel(nursesById, a.nurseId)} ${a.before.toFixed(0)}→${a.after.toFixed(0)}`,
                  )
                  .join(', ')}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Cost</dt>
          <dd className={cost.delta > 0 ? 'text-warn' : cost.delta < 0 ? 'text-success' : ''}>
            {formatSignedDollars(cost.delta)}
            {cost.unpriced ? (
              <span className="ml-1 rounded bg-warn/15 px-1 text-[10px] uppercase text-warn">
                unpriced
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {softViolationsIntroduced.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5 text-xs text-warn">
          {softViolationsIntroduced.map((v) => (
            <li key={`${v.ruleId}:${v.nurseIds.join(',')}:${v.dates.join(',')}`}>
              Introduces: {v.message}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
