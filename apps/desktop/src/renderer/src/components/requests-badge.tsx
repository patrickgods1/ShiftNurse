/**
 * The count on the Requests nav item: time off and shift exchanges still waiting for the
 * manager's decision. Without it a request sat unseen until someone opened the page. Time off
 * comes from the dashboard summary the app already loads; exchanges from the unit's proposed
 * list. Both queries are invalidated by the hooks that decide a request, so the count falls
 * as soon as one is decided.
 */

import type { Id } from '@shiftnurse/core';
import { useDashboard } from '../api.js';
import { useExchangesForUnit } from '../api-exchange.js';

export function useWaitingRequestCount(unitId: Id): number {
  const timeOff = useDashboard(unitId).data?.pendingTimeOff ?? 0;
  const exchanges = useExchangesForUnit(unitId, 'proposed').data?.length ?? 0;
  return timeOff + exchanges;
}

/** The pill is `aria-hidden`: the link's own accessible name carries the count in words. */
export function RequestsBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="requests-badge"
      aria-hidden="true"
      className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-warn/20
        px-1.5 text-xs font-semibold text-text [.active_&]:bg-white/25 [.active_&]:text-white"
    >
      {count}
    </span>
  );
}

export function requestsLabel(count: number): string {
  return count > 0 ? `Requests, ${count} waiting for a decision` : 'Requests';
}
