/**
 * Which period the manager is looking at, shared by every page that shows one period at a time
 * (Schedule, Requests, Fairness, Staffing needs). Each page used to keep its own copy, so choosing
 * November on Schedule and opening Fairness landed on the default again, and Staffing needs used a
 * fourth rule (the first draft in list order). The provider holds the chosen id only: v1 has one
 * unit, and the period list itself stays in the query cache.
 */

import type { Id, SchedulePeriod } from '@shiftnurse/core';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { defaultPeriod } from './default-period.js';

interface SelectedPeriodContextValue {
  chosenId: Id | undefined;
  setChosenId: (id: Id) => void;
}

const SelectedPeriodContext = createContext<SelectedPeriodContextValue | undefined>(undefined);

/** Holds which period the manager chose, for every page that shows one period at a time. */
export function SelectedPeriodProvider({ children }: { children: ReactNode }) {
  const [chosenId, setChosenId] = useState<Id | undefined>(undefined);
  const value = useMemo(() => ({ chosenId, setChosenId }), [chosenId]);
  return <SelectedPeriodContext.Provider value={value}>{children}</SelectedPeriodContext.Provider>;
}

/**
 * The period to show: the one the manager chose on any page, if it is still in `periods`;
 * otherwise `defaultPeriod(periods)`, which is then pinned as the choice so a status change
 * (publishing the draft) does not move the page to another period.
 */
export function useSelectedPeriod(periods: readonly SchedulePeriod[]): {
  period: SchedulePeriod | undefined;
  select: (id: Id) => void;
} {
  const context = useContext(SelectedPeriodContext);
  if (context === undefined) {
    throw new Error('useSelectedPeriod must be used within SelectedPeriodProvider');
  }
  const { chosenId, setChosenId } = context;
  const fallback = useMemo(() => defaultPeriod(periods), [periods]);

  useEffect(() => {
    if (chosenId === undefined && fallback !== undefined) setChosenId(fallback.id);
  }, [chosenId, fallback, setChosenId]);

  const period = periods.find((p) => p.id === chosenId) ?? fallback;
  const select = useCallback((id: Id) => setChosenId(id), [setChosenId]);
  return { period, select };
}
