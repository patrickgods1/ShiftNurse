/**
 * Which scheduling period a page should land on when it first opens: the current draft if
 * there is one — that's what a manager is actively building — else the most recently started
 * period of any status, so a page never renders empty when a unit has only published/archived
 * history. Shared by Schedule and Fairness so "the period you land on" means the same thing in
 * both places instead of silently drifting apart.
 */

import type { SchedulePeriod } from '@shiftnurse/core';
import { compareDates } from '@shiftnurse/core';

export function defaultPeriod(periods: readonly SchedulePeriod[]): SchedulePeriod | undefined {
  if (periods.length === 0) return undefined;
  const drafts = periods.filter((p) => p.status === 'draft');
  const pool = drafts.length > 0 ? drafts : periods;
  return [...pool].sort((a, b) => compareDates(b.startDate, a.startDate))[0];
}
