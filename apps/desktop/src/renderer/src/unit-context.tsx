/**
 * ShiftNurse v1 manages exactly one unit, but the IPC contract still takes a `unitId` on every
 * call (see shared/api.ts) because that seam is what lets a future multi-unit build reuse the
 * same API unchanged. This context resolves "the" unit once at the app root, so pages don't
 * each re-ask for it and don't each re-implement the "no unit configured yet" state.
 *
 * "The" unit is the home unit main marks, not the first of `units.list()`: that list is
 * alphabetical, and once a float sibling sorted first, renaming the home unit switched every
 * page (Settings › Unit included) to the sibling.
 */

import type { Id, Unit } from '@shiftnurse/core';
import { createContext, type ReactNode, useContext } from 'react';
import { useHomeUnit } from './api.js';
import { AsyncState } from './components/async-state.js';

interface UnitContextValue {
  unit: Unit;
}

const UnitContext = createContext<UnitContextValue | undefined>(undefined);

export function UnitProvider({ children }: { children: ReactNode }) {
  const homeQuery = useHomeUnit();

  if (homeQuery.isPending) {
    return <AsyncState status="loading" label="Loading unit" />;
  }
  if (homeQuery.isError) {
    return <AsyncState status="error" label="Could not load unit" error={homeQuery.error} />;
  }
  const unit = homeQuery.data;
  if (unit === undefined) {
    return <AsyncState status="empty" label="No unit is configured yet" />;
  }

  return <UnitContext.Provider value={{ unit }}>{children}</UnitContext.Provider>;
}

function useUnitContext(): UnitContextValue {
  const value = useContext(UnitContext);
  if (value === undefined) {
    throw new Error('useUnitId/useUnit must be used within a UnitProvider');
  }
  return value;
}

export function useUnitId(): Id {
  return useUnitContext().unit.id;
}

export function useUnit(): Unit {
  return useUnitContext().unit;
}
