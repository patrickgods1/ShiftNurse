/**
 * Acuity configuration: the tiers, patient-ratio ceilings and HPPD budget that
 * `acuity/demand.ts` turns into per-shift staffing minimums (see that module's header for how
 * the three combine). Ratio rules are deactivated rather than deleted — like shift types, they
 * may be cited by the demand math behind an already-published schedule, and a rule's citation
 * text is exactly what a manager would quote back if a staffing decision were challenged, so
 * the historical record has to stay intact.
 */

import { useAcuityTiers, useRatioRules } from '../../api-config.js';
import { AsyncState } from '../../components/async-state.js';
import { useUnitId } from '../../unit-context.js';
import { HppdSection } from './acuity/hppd.js';
import { RatioRulesSection } from './acuity/ratios.js';
import { AcuityTiersSection } from './acuity/tiers.js';

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export default function AcuityPanel() {
  const unitId = useUnitId();
  const tiersQuery = useAcuityTiers(unitId);
  const rulesQuery = useRatioRules(unitId);

  if (tiersQuery.isPending || rulesQuery.isPending) {
    return <AsyncState status="loading" label="Loading acuity configuration" />;
  }
  if (tiersQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load acuity tiers" error={tiersQuery.error} />
    );
  }
  if (rulesQuery.isError) {
    return (
      <AsyncState status="error" label="Could not load ratio rules" error={rulesQuery.error} />
    );
  }

  return (
    <div data-testid="acuity-panel" className="flex flex-col gap-8">
      <AcuityTiersSection unitId={unitId} tiers={tiersQuery.data} />
      <RatioRulesSection unitId={unitId} tiers={tiersQuery.data} rules={rulesQuery.data} />
      <HppdSection unitId={unitId} />
    </div>
  );
}
