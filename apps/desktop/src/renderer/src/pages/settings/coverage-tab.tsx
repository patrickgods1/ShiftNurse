/**
 * Coverage floors with their data loaded: `CoverageFloors` takes the shift types and floors as
 * props, and both Settings and the assisted setup guide show it with the same loading states.
 */

import { useCoverage, useShiftTypesList } from '../../api-config.js';
import { AsyncState } from '../../components/async-state.js';
import { useUnitId } from '../../unit-context.js';
import CoverageFloors from './coverage-floors.js';

export function CoverageTab() {
  const unitId = useUnitId();
  const shiftTypesQuery = useShiftTypesList(unitId);
  const coverageQuery = useCoverage(unitId);

  if (shiftTypesQuery.isPending || coverageQuery.isPending) {
    return <AsyncState status="loading" label="Loading coverage floors" />;
  }
  if (shiftTypesQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load shift types" error={shiftTypesQuery.error} />
    );
  }
  if (coverageQuery.isError) {
    return (
      <AsyncState
        status="error"
        label="Could not load coverage floors"
        error={coverageQuery.error}
      />
    );
  }

  return (
    <CoverageFloors
      unitId={unitId}
      shiftTypes={shiftTypesQuery.data}
      requirements={coverageQuery.data}
    />
  );
}
