/**
 * The per-nurse fairness table: sorted so the nurse the manager most needs to look at — the
 * lowest, most-comparable score — is first. Each row expands into the component breakdown that
 * explains the number, because "your score is 61" is not an answer a manager can give in a
 * staff meeting; "you carried 12 nights against a fair share of 8" is (see the module header in
 * packages/core/src/fairness/types.ts).
 */

import type {
  ComponentScore,
  FairnessComponent,
  Nurse,
  NurseFairnessScore,
} from '@shiftnurse/core';
import { FAIRNESS_COMPONENT_LABELS, FAIRNESS_COMPONENTS } from '@shiftnurse/core';
import { useId, useState } from 'react';
import type { FairnessTrendPoint } from '../../../../shared/api.js';
import { SCORE_BAR_CLASSES, SCORE_TONE_CLASSES, scoreTone } from './score-tone.js';
import { Sparkline } from './sparkline.js';

interface NurseFairnessTableProps {
  scores: NurseFairnessScore[];
  nurses: Nurse[];
  trend: FairnessTrendPoint[];
}

function nurseName(nurse: Nurse | undefined): string {
  return nurse !== undefined ? `${nurse.firstName} ${nurse.lastName}` : 'Unknown nurse';
}

/** Comparable nurses (the ones a burden reading actually applies to) sort first, lowest score
 * first within that group — that ordering is the point of the table. Nurses with no share
 * weight (no contracted hours to compare against) trail, since their score isn't a burden
 * signal to act on. */
function sortScores(scores: NurseFairnessScore[]): NurseFairnessScore[] {
  return [...scores].sort((a, b) => {
    if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
    return a.score - b.score;
  });
}

function componentsByKey(components: ComponentScore[]): Map<FairnessComponent, ComponentScore> {
  return new Map(components.map((c) => [c.component, c]));
}

function ComponentBar({ component }: { component: ComponentScore }) {
  const tone = scoreTone(component.score);
  return (
    <div className="grid grid-cols-[9rem_1fr_3rem] items-center gap-3 py-1.5">
      <span className="text-sm text-text">{FAIRNESS_COMPONENT_LABELS[component.component]}</span>
      <div
        role="img"
        aria-label={`${FAIRNESS_COMPONENT_LABELS[component.component]}: ${component.score.toFixed(0)} of 100`}
        className="h-2 rounded-full bg-border"
      >
        <div
          className={`h-2 rounded-full ${SCORE_BAR_CLASSES[tone]}`}
          style={{ width: `${Math.max(0, Math.min(100, component.score))}%` }}
        />
      </div>
      <span className={`text-right text-sm tabular-nums ${SCORE_TONE_CLASSES[tone]}`}>
        {component.score.toFixed(0)}
      </span>
    </div>
  );
}

function NurseBreakdown({ score }: { score: NurseFairnessScore }) {
  const byKey = componentsByKey(score.components);
  return (
    <div className="px-4 py-3">
      <div className="flex flex-col divide-y divide-border">
        {FAIRNESS_COMPONENTS.map((component) => {
          const entry = byKey.get(component);
          if (entry === undefined) return null;
          return (
            <div key={component} className="py-1.5">
              <ComponentBar component={entry} />
              <p className="pl-0 text-xs text-text-muted">
                {entry.explanation} · effective weight {entry.weight.toFixed(2)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NurseRow({
  score,
  nurse,
  trendValues,
}: {
  score: NurseFairnessScore;
  nurse: Nurse | undefined;
  trendValues: number[];
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const tone = scoreTone(score.score);

  return (
    <>
      <tr data-testid="fairness-row" className="border-b border-border last:border-0">
        <td className="px-3 py-2">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((prev) => !prev)}
            className="flex items-center gap-2 text-left text-sm font-medium text-text hover:text-accent"
          >
            <span
              aria-hidden="true"
              className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}
            >
              ▸
            </span>
            {nurseName(nurse)}
          </button>
        </td>
        <td className="px-3 py-2 text-sm text-text">{nurse?.role ?? '—'}</td>
        <td className="px-3 py-2 text-sm tabular-nums text-text">
          {nurse !== undefined ? nurse.fte.toFixed(2) : '—'}
        </td>
        <td className="px-3 py-2 text-sm tabular-nums">
          {score.comparable ? (
            <span className={SCORE_TONE_CLASSES[tone]}>{score.score.toFixed(0)}</span>
          ) : (
            <span className="text-text-muted" title="No contracted-hours share to compare against">
              n/a
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-sm tabular-nums text-text">
          {score.burdenIndex >= 0 ? '+' : ''}
          {score.burdenIndex.toFixed(1)}
        </td>
        <td className="px-3 py-2 text-sm tabular-nums text-text">
          ×{score.seniorityMultiplier.toFixed(2)}
        </td>
        <td className="px-3 py-2">
          <Sparkline values={trendValues} />
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={7} id={panelId} className="border-b border-border bg-bg last:border-0">
            <NurseBreakdown score={score} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function NurseFairnessTable({ scores, nurses, trend }: NurseFairnessTableProps) {
  const nursesById = new Map(nurses.map((n) => [n.id, n]));
  const sorted = sortScores(scores);

  if (sorted.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface p-8 text-center text-text-muted">
        No nurses scored for this period.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table data-testid="fairness-table" className="w-full min-w-[760px] border-collapse text-sm">
        <caption className="sr-only">
          Per-nurse fairness scores for this period, lowest score first
        </caption>
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Nurse
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Role
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              FTE
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Score
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Burden index
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Seniority
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Trend
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((score) => (
            <NurseRow
              key={score.nurseId}
              score={score}
              nurse={nursesById.get(score.nurseId)}
              trendValues={trend
                .map((point) => point.scores[score.nurseId])
                .filter((value): value is number => value !== undefined)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
