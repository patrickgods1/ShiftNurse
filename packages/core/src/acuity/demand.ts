/**
 * Turns a census forecast into concrete staffing demand.
 *
 * This is the layer that makes the app healthcare-specific rather than a generic shift
 * scheduler. Demand is not a fixed number per weekday — it is derived from how many
 * patients are expected and how sick they are, then floored by the contractual/safety
 * minimum so a quiet day never strips the unit below its baseline.
 *
 * Three inputs, with clearly separated force:
 *
 * 1. **Ratio rules** (hard) — legal/contractual patients-per-nurse ceilings. Breaching one
 *    makes a schedule infeasible, not merely suboptimal.
 * 2. **Coverage floors** (hard) — the static baseline per shift and weekday, independent of
 *    census. Demand is `max(floor, ratio-derived)`; acuity can only push staffing up.
 * 3. **HPPD target** (soft) — nursing hours per patient day. A budget goal that informs the
 *    objective function and the dashboard, never a constraint. Reported at the shift level
 *    rather than split across roles, because apportioning it per role would be invention.
 */

import type {
  AcuityTier,
  CensusForecast,
  CoverageRequirement,
  HppdTarget,
  Id,
  NurseRole,
  RatioRule,
  ShiftType,
} from '../domain/entities.js';
import { type IsoDate, type Weekday, weekdayOf } from '../domain/time.js';

export const NURSE_ROLES: readonly NurseRole[] = ['RN', 'LPN', 'CNA'] as const;

/** Why a role's minimum landed where it did — surfaced in the UI so the number is explainable. */
export type BindingConstraint = 'coverage_floor' | 'ratio' | 'both';

export interface RoleDemand {
  role: NurseRole;
  /** Hard minimum: `max(coverageFloorMin, ratioDerived)`. */
  minCount: number;
  /** Soft goal: never below `minCount`. */
  targetCount: number;
  coverageFloorMin: number;
  coverageFloorTarget: number;
  /** Nurses required purely by patients-per-nurse ceilings. */
  ratioDerived: number;
  bindingConstraint: BindingConstraint;
}

export interface ShiftDemand {
  date: IsoDate;
  shiftTypeId: Id;
  projectedCensus: number;
  /** Total nursing care hours the census implies for a full day at this acuity mix. */
  weightedCareHoursPerDay: number;
  /** Care hours attributable to this shift, pro-rated by its share of the 24-hour day. */
  careHoursThisShift: number;
  /** Soft, unit-level: nurses the HPPD target suggests for this shift. */
  hppdRecommendedNurses: number;
  byRole: Record<NurseRole, RoleDemand>;
  /** True when no forecast existed and only the static coverage floor applied. */
  fromCoverageFloorOnly: boolean;
}

export interface DemandInputs {
  shiftTypes: readonly ShiftType[];
  acuityTiers: readonly AcuityTier[];
  ratioRules: readonly RatioRule[];
  coverageRequirements: readonly CoverageRequirement[];
  censusForecasts: readonly CensusForecast[];
  hppdTarget?: HppdTarget;
}

/**
 * Indexed staffing demand for a date range. Built once per solve/validation pass and
 * queried heavily, so lookups are O(1).
 */
export class DemandTable {
  private readonly byKey = new Map<string, ShiftDemand>();

  constructor(demands: readonly ShiftDemand[]) {
    for (const d of demands) this.byKey.set(key(d.date, d.shiftTypeId), d);
  }

  get(date: IsoDate, shiftTypeId: Id): ShiftDemand | undefined {
    return this.byKey.get(key(date, shiftTypeId));
  }

  /** The hard minimum for one role on one shift. Zero when nothing is required. */
  minFor(date: IsoDate, shiftTypeId: Id, role: NurseRole): number {
    return this.get(date, shiftTypeId)?.byRole[role]?.minCount ?? 0;
  }

  targetFor(date: IsoDate, shiftTypeId: Id, role: NurseRole): number {
    return this.get(date, shiftTypeId)?.byRole[role]?.targetCount ?? 0;
  }

  all(): ShiftDemand[] {
    return [...this.byKey.values()];
  }

  /** Every (date, shift) that requires at least one nurse in any role. */
  staffedShifts(): ShiftDemand[] {
    return this.all().filter((d) =>
      NURSE_ROLES.some((role) => (d.byRole[role]?.minCount ?? 0) > 0),
    );
  }
}

function key(date: IsoDate, shiftTypeId: Id): string {
  return `${date}::${shiftTypeId}`;
}

// ---------------------------------------------------------------------------
// Ratio maths
// ---------------------------------------------------------------------------

/**
 * Pick the binding ratio for a role at an acuity tier: a tier-specific rule if one exists,
 * otherwise the catch-all rule. Where several apply, the most restrictive (lowest patients
 * per nurse) wins — safety rules stack conservatively.
 */
export function bindingRatio(
  rules: readonly RatioRule[],
  role: NurseRole,
  acuityTierId: Id,
): number | null {
  let best: number | null = null;
  for (const rule of rules) {
    if (!rule.active || rule.role !== role) continue;
    if (rule.acuityTierId !== null && rule.acuityTierId !== acuityTierId) continue;
    if (rule.maxPatientsPerNurse <= 0) continue;
    if (best === null || rule.maxPatientsPerNurse < best) best = rule.maxPatientsPerNurse;
  }
  return best;
}

/**
 * Nurses of one role required to cover a patient mix without breaching any ratio.
 *
 * Each tier contributes a fractional nurse-load (`patients / maxPatientsPerNurse`); the
 * loads are summed and rounded up once. Summing fractions before rounding — rather than
 * rounding each tier — reflects that one nurse can carry a mixed assignment, which is how
 * charge nurses actually distribute patients. This is the standard relaxation used for
 * ratio compliance and never under-staffs relative to the per-tier ceilings in aggregate.
 */
export function nursesRequiredForMix(
  acuityMix: Record<Id, number>,
  role: NurseRole,
  ratioRules: readonly RatioRule[],
): number {
  let load = 0;
  let sawAnyRule = false;
  for (const [tierId, patients] of Object.entries(acuityMix)) {
    if (!patients || patients <= 0) continue;
    const ratio = bindingRatio(ratioRules, role, tierId);
    if (ratio === null) continue; // This role is not ratio-governed for this tier.
    sawAnyRule = true;
    load += patients / ratio;
  }
  if (!sawAnyRule) return 0;
  return Math.ceil(roundForFloatSafety(load));
}

/** Guards against 6/2 = 2.9999999996 rounding up to 3. */
function roundForFloatSafety(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** Total nursing hours a patient mix demands for a full 24-hour day. */
export function weightedCareHours(
  acuityMix: Record<Id, number>,
  tiers: readonly AcuityTier[],
): number {
  const byId = new Map(tiers.map((t) => [t.id, t]));
  let hours = 0;
  for (const [tierId, patients] of Object.entries(acuityMix)) {
    if (!patients || patients <= 0) continue;
    const tier = byId.get(tierId);
    if (!tier) continue;
    hours += patients * tier.careHoursPerPatientDay;
  }
  return hours;
}

// ---------------------------------------------------------------------------
// Coverage floors
// ---------------------------------------------------------------------------

/**
 * The static floor for a role on a given date and shift. A date-specific override beats the
 * weekday rule — that is how a manager pre-staffs a known-heavy day such as a holiday.
 */
export function coverageFloorFor(
  requirements: readonly CoverageRequirement[],
  date: IsoDate,
  shiftTypeId: Id,
  role: NurseRole,
): { min: number; target: number } {
  const weekday: Weekday = weekdayOf(date);
  let weekdayMatch: CoverageRequirement | undefined;
  let dateMatch: CoverageRequirement | undefined;

  for (const req of requirements) {
    if (req.shiftTypeId !== shiftTypeId || req.role !== role) continue;
    if (req.date === date) dateMatch = req;
    else if (req.date === null && req.weekday === weekday) weekdayMatch = req;
  }

  const chosen = dateMatch ?? weekdayMatch;
  if (!chosen) return { min: 0, target: 0 };
  return { min: chosen.minCount, target: Math.max(chosen.targetCount, chosen.minCount) };
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Build the staffing demand for every date and shift type across a range. */
export function deriveDemand(dates: readonly IsoDate[], inputs: DemandInputs): DemandTable {
  const { shiftTypes, acuityTiers, ratioRules, coverageRequirements, censusForecasts, hppdTarget } =
    inputs;

  const forecastIndex = new Map<string, CensusForecast>();
  for (const f of censusForecasts) forecastIndex.set(key(f.date, f.shiftTypeId), f);

  const demands: ShiftDemand[] = [];

  for (const date of dates) {
    for (const shiftType of shiftTypes) {
      if (!shiftType.active) continue;

      const forecast = forecastIndex.get(key(date, shiftType.id));
      const acuityMix = forecast?.acuityMix ?? {};
      const projectedCensus = forecast?.projectedCensus ?? 0;

      const careHoursPerDay = weightedCareHours(acuityMix, acuityTiers);
      const shiftShareOfDay = shiftType.durationHours / 24;
      const careHoursThisShift = careHoursPerDay * shiftShareOfDay;

      const hppdRecommendedNurses =
        hppdTarget && projectedCensus > 0 && shiftType.durationHours > 0
          ? (hppdTarget.targetHours * projectedCensus * shiftShareOfDay) / shiftType.durationHours
          : 0;

      const byRole = {} as Record<NurseRole, RoleDemand>;
      for (const role of NURSE_ROLES) {
        const floor = coverageFloorFor(coverageRequirements, date, shiftType.id, role);
        // On-call shifts stand outside ratio maths: they are standby capacity, not
        // bedside coverage, so only the explicit coverage floor applies.
        const ratioDerived = shiftType.isOnCall
          ? 0
          : nursesRequiredForMix(acuityMix, role, ratioRules);

        const minCount = Math.max(floor.min, ratioDerived);
        const bindingConstraint: BindingConstraint =
          floor.min === ratioDerived
            ? 'both'
            : minCount === ratioDerived
              ? 'ratio'
              : 'coverage_floor';

        byRole[role] = {
          role,
          minCount,
          targetCount: Math.max(floor.target, minCount),
          coverageFloorMin: floor.min,
          coverageFloorTarget: floor.target,
          ratioDerived,
          bindingConstraint,
        };
      }

      demands.push({
        date,
        shiftTypeId: shiftType.id,
        projectedCensus,
        weightedCareHoursPerDay: careHoursPerDay,
        careHoursThisShift,
        hppdRecommendedNurses,
        byRole,
        fromCoverageFloorOnly: forecast === undefined,
      });
    }
  }

  return new DemandTable(demands);
}

/**
 * Re-derive demand for a single shift against the census actually on the floor.
 *
 * Forecasts are wrong sometimes. The day-of console uses this to answer "given we actually
 * have 26 patients, not the 22 we predicted, are we still ratio-compliant right now?"
 */
export function demandForActualCensus(
  date: IsoDate,
  shiftType: ShiftType,
  actualCensus: number,
  actualAcuityMix: Record<Id, number>,
  inputs: DemandInputs,
): ShiftDemand {
  const synthetic: CensusForecast = {
    id: 'actual',
    unitId: shiftType.unitId,
    date,
    shiftTypeId: shiftType.id,
    projectedCensus: actualCensus,
    acuityMix: actualAcuityMix,
    source: 'manual',
  };
  const table = deriveDemand([date], {
    ...inputs,
    shiftTypes: [shiftType],
    censusForecasts: [synthetic],
  });
  const demand = table.get(date, shiftType.id);
  /* istanbul ignore next — deriveDemand always emits a row for an active shift type. */
  if (!demand) throw new Error(`Failed to derive demand for ${date} / ${shiftType.id}`);
  return demand;
}
