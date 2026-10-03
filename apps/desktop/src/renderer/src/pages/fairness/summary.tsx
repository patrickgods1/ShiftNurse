/**
 * The unit-level read of a period's fairness report: four headline numbers, then a per-component
 * strip. A manager opens this before the per-nurse table — "is this period even, and if not,
 * which burden is doing it" — the per-nurse rows are where they go to find out *who*.
 */

import type { FairnessComponent, FairnessReport } from '@shiftnurse/core';
import { FAIRNESS_COMPONENT_LABELS, FAIRNESS_COMPONENTS, gini } from '@shiftnurse/core';
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

/**
 * The burden doing most to make the period unfair: unevenness weighted by how much the unit
 * says that burden matters. Unweighted, a barely weighted measure (a little overtime carried
 * over from history) headed the page on a schedule with no overtime at all.
 */
function worstComponent(
  components: Record<FairnessComponent, { gini: number; max: number }>,
  weights: Record<FairnessComponent, number>,
): { component: FairnessComponent; gini: number } | undefined {
  let worst: { component: FairnessComponent; gini: number; impact: number } | undefined;
  for (const component of FAIRNESS_COMPONENTS) {
    const stats = components[component];
    if (stats.max === 0) continue;
    const impact = stats.gini * weights[component];
    if (impact > 0 && (worst === undefined || impact > worst.impact)) {
      worst = { component, gini: stats.gini, impact };
    }
  }
  return worst;
}

interface FairnessSummaryProps {
  report: FairnessReport;
  /** Nurses with contracted hours, the ones the headline numbers are about. */
  contracted: ReadonlySet<string>;
}

export function FairnessSummary({ report, contracted }: FairnessSummaryProps) {
  // The headline is about staff with a contracted share: a per-diem nurse's low score means
  // they picked up what they were asked to, and would otherwise set "lowest" for the unit.
  const values = report.scores.filter((s) => contracted.has(s.nurseId)).map((s) => s.score);
  const score =
    values.length === 0
      ? { count: 0, mean: 0, min: 0, max: 0, gini: 0 }
      : {
          count: values.length,
          mean: values.reduce((a, b) => a + b, 0) / values.length,
          min: Math.min(...values),
          max: Math.max(...values),
          gini: gini(values),
        };
  const worst = worstComponent(report.distribution.components, report.weights);

  return (
    <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4" data-testid="fairness-summary">
      <StatCard
        label="Average fairness (100 = everyone at their fair share)"
        value={score.count > 0 ? score.mean.toFixed(0) : '—'}
        tone={score.count > 0 ? scoreStatTone(score.mean) : 'neutral'}
      />
      <StatCard
        label="Lowest to highest"
        value={score.count > 0 ? `${score.min.toFixed(0)}–${score.max.toFixed(0)}` : '—'}
        tone={score.count > 0 ? scoreStatTone(score.min) : 'neutral'}
      />
      <StatCard
        label="How evenly shared (0 = perfectly even)"
        value={score.count > 0 ? score.gini.toFixed(2) : '—'}
        tone={score.count > 0 ? giniTone(score.gini) : 'neutral'}
      />
      <StatCard
        label="Biggest gap"
        value={worst !== undefined ? FAIRNESS_COMPONENT_LABELS[worst.component] : 'None'}
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
              What is shared
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              How much it counts
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Unevenness (0 = even)
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Range across nurses
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
                <td className="px-3 py-2 tabular-nums text-text">
                  {Math.round(stats.min * 100)}% – {Math.round(stats.max * 100)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-border px-3 py-2 text-xs text-text-muted">
        Burdens (nights, weekends, holidays, on call, overtime) are shown as a share of each nurse's
        fair share, this period and recently: 100% is exactly fair. Preferences and requests are the
        share honoured.
      </p>
    </div>
  );
}
