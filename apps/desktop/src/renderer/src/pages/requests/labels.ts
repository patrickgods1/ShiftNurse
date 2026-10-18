/**
 * Words for the codes the exchange and conflict screens would otherwise print raw. A manager
 * reading "proposed" or "-1 slot short" has to translate; one reading these does not.
 */

import type { ExchangeEvaluation, ShiftSwapStatus } from '@shiftnurse/core';

export const SWAP_STATUS_LABELS: Readonly<Record<ShiftSwapStatus, string>> = {
  proposed: 'Waiting for a decision',
  approved: 'Approved',
  denied: 'Denied',
  cancelled: 'Cancelled',
};

type ExchangeVerdict = ExchangeEvaluation['verdict'];

export const VERDICT_LABELS: Readonly<Record<ExchangeVerdict, string>> = {
  ok: 'No problems found',
  warn: 'Allowed, with warnings',
  blocked: 'Not allowed',
};

/** "1 fewer slot short", "2 more slots short", "no change". A negative delta is an improvement. */
export function coverageDeltaLabel(delta: number): string {
  if (delta === 0) return 'no change';
  const n = Math.abs(delta);
  return `${n} ${delta < 0 ? 'fewer' : 'more'} slot${n === 1 ? '' : 's'} short`;
}
