/**
 * Which rule version a schedule is judged under, and the offer to move a draft to the latest.
 *
 * A draft keeps the version it was created under, so after the manager fixes a rule, Generate
 * and the violation list still use the old one and nothing on screen said so. The comparison
 * lives in `latestRulesVersionAfter`, once, for the pill and the publish dialog.
 */

import type { RuleSet, SchedulePeriod } from '@shiftnurse/core';
import { errorMessage, SECONDARY } from '../../components/ui.js';
import type { StatusItem } from './status-row.js';

/** The latest rule version when it is newer than the one the period is pinned to. */
export function latestRulesVersionAfter(
  period: Pick<SchedulePeriod, 'ruleSetVersion'>,
  latest: Pick<RuleSet, 'version'> | undefined,
): number | undefined {
  return latest !== undefined && latest.version > period.ruleSetVersion
    ? latest.version
    : undefined;
}

export interface RulesVersionPillProps {
  period: SchedulePeriod;
  latest: Pick<RuleSet, 'version'> | undefined;
  onAdopt: () => void;
  pending: boolean;
  error: unknown;
}

/** Only a draft can move, so only a draft behind the latest version gets a pill. */
export function rulesVersionPill({
  period,
  latest,
  onAdopt,
  pending,
  error,
}: RulesVersionPillProps): StatusItem | undefined {
  if (period.status !== 'draft') return undefined;
  const newer = latestRulesVersionAfter(period, latest);
  if (newer === undefined) return undefined;
  const n = period.ruleSetVersion;
  return {
    id: 'rules-version',
    testId: 'rules-version',
    tone: 'warn',
    label: `Rules v${n} · latest v${newer}`,
    title: `This draft is judged and generated under rules version ${n}; version ${newer} was saved later.`,
    detail: (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="text-text">This draft uses rules v{n} — use the latest?</p>
        <button type="button" className={SECONDARY} disabled={pending} onClick={onAdopt}>
          Use the latest rules
        </button>
        {error ? (
          <p role="alert" className="text-danger">
            {errorMessage(error)}
          </p>
        ) : null}
      </div>
    ),
  };
}
