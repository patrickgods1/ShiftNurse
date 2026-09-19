/**
 * The unit-level read of a period's fairness report: four headline numbers, then a per-component
 * strip. A manager opens this before the per-nurse table — "is this period even, and if not,
 * which burden is doing it" — the per-nurse rows are where they go to find out *who*.
 */

import type { FairnessComponent, FairnessReport } from '@shiftnurse/core';
import { FAIRNESS_COMPONENT_LABELS, FAIRNESS_COMPONENTS } from '@shiftnurse/core';
import { StatCard } from '../../components/stat-card.js';

/** Gini bands for the stat-card tone. There is no hard threshold in the domain model — these
 * are a reading aid, so the underlying number is always shown alongside the colour. */
function giniTone(gini: number): 'neutral' | 'warn' | 'danger' {
  if (gini >= 0.4) return 'danger';
  if (gini >= 0.25) return 'warn';
  return 'neutral';
}

function scoreStatTone(mean: number): 'neutral' | 'warn' | 'danger' {
  if (mean < 60) return 'danger';
  if (mean < 85) return 'warn';
  return 'neutral';
}

function worstComponent(
  components: Record<FairnessComponent, { gini: number }>,
): { component: FairnessComponent; gini: number } | undefined {
  let worst: { component: FairnessComponent; gini: number } | undefined;
  for (const component of FAIRNESS_COMPONENTS) {
    const stats = components[component];
    if (worst === undefined || stats.gini > worst.gini) {
      worst = { component, gini: stats.gini };
    }
  }
  return worst;
}

interface FairnessSummaryProps {
  report: FairnessReport;
}

export function FairnessSummary({ report }: FairnessSummaryProps) {
  const { score } = report.distribution;
  const worst = worstComponent(report.distribution.components);

  return (
    <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="fairness-summary">
      <StatCard
        label="Mean score"
        value={score.count > 0 ? score.mean.toFixed(1) : '—'}
        tone={score.count > 0 ? scoreStatTone(score.mean) : 'neutral'}
      />
      <StatCard
        label="Score evenness (Gini)"
        value={score.count > 0 ? score.gini.toFixed(2) : '—'}
        tone={score.count > 0 ? giniTone(score.gini) : 'neutral'}
      />
      <StatCard
        label="Score spread"
        value={score.count > 0 ? `${score.min.toFixed(0)}–${score.max.toFixed(0)}` : '—'}
      />
      <StatCard
        label="Most uneven"
        value={worst !== undefined ? FAIRNESS_COMPONENT_LABELS[worst.component] : '—'}
        tone={worst !== undefined ? giniTone(worst.gini) : 'neutral'}
      />
    </div>
  );
}

interface ComponentStripProps {
  report: FairnessReport;
}

/** One row per fairness component: how uneven it is, and the range of rates behind that
 * number. Burden components read as carried ÷ fair share (1.00 = exactly fair); equity
 * components read as a 0–1 hit rate. */
export function ComponentDistributionStrip({ report }: ComponentStripProps) {
  return (
    <div className="mb-8 overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full min-w-[520px] border-collapse text-sm">
        <caption className="sr-only">Fairness component distribution for this period</caption>
        <thead>
          <tr className="border-b border-border text-left text-text-muted">
            <th scope="col" className="px-3 py-2 font-medium">
              Component
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Weight
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Gini
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Min
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Max
            </th>
          </tr>
        </thead>
        <tbody>
          {FAIRNESS_COMPONENTS.map((component) => {
            const stats = report.distribution.components[component];
            return (
              <tr key={component} className="border-b border-border last:border-0">
                <td className="px-3 py-2 text-text">{FAIRNESS_COMPONENT_LABELS[component]}</td>
                <td className="px-3 py-2 tabular-nums text-text">
                  {report.weights[component].toFixed(1)}
                </td>
                <td className="px-3 py-2 tabular-nums text-text">{stats.gini.toFixed(2)}</td>
                <td className="px-3 py-2 tabular-nums text-text">{stats.min.toFixed(2)}</td>
                <td className="px-3 py-2 tabular-nums text-text">{stats.max.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
