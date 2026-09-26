/**
 * Pay configuration: base rates (a default per role plus per-nurse overrides), the
 * differentials that stack on top of them, and the overtime rules. Everything the cost engine
 * prices from lives on this one tab, because a manager reconciling a payroll surprise wants to
 * check "what do we pay for a Saturday night charge shift" in one place.
 *
 * Rates are dated rather than edited in place: a raise is a new row effective from a date, so
 * the shifts before it keep pricing at the old rate. Editing an existing row exists for typos.
 */

import { useNurses } from '../../api.js';
import { AsyncState } from '../../components/async-state.js';
import { useUnitId } from '../../unit-context.js';
import { DifferentialsSection } from './pay/differentials.js';
import { OvertimeSection } from './pay/overtime.js';
import { PayRatesSection } from './pay/rates.js';

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function PayPanel() {
  const unitId = useUnitId();
  const nursesQuery = useNurses(unitId);

  if (nursesQuery.isPending) return <AsyncState status="loading" label="Loading roster" />;
  if (nursesQuery.isError) {
    return <AsyncState status="error" label="Could not load roster" error={nursesQuery.error} />;
  }

  return (
    <div data-testid="pay-panel">
      <PayRatesSection unitId={unitId} nurses={nursesQuery.data} />
      <DifferentialsSection unitId={unitId} />
      <OvertimeSection unitId={unitId} />
    </div>
  );
}
