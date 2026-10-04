/**
 * Coverage and safety rules — is this shift actually safe to run?
 *
 * Staffing shortfalls are reported against two separate standards, deliberately kept apart
 * because they carry different consequences and different citations:
 *
 * - **Coverage floor** — the unit's contractual/baseline staffing. A shortfall is a
 *   contract problem.
 * - **Patient ratio** — the legal patients-per-nurse ceiling derived from census and acuity.
 *   A breach is a regulatory problem and is worded to say so.
 *
 * Collapsing both into one "understaffed" message would lose exactly the distinction a
 * manager needs when deciding how hard to fight for the extra nurse.
 */

import { NURSE_ROLES, type RoleDemand } from '../acuity/demand.js';
import type { Id, NurseCredential, NurseRole } from '../domain/entities.js';
import { compareDates, describeDate, type IsoDate } from '../domain/time.js';
import { coveringShift } from '../schedule/cover.js';
import type { AssignmentView, ScheduleView } from '../schedule/view.js';
import { type Rule, type RuleContext, type Violation, violation } from './types.js';

/** A credential is valid on a date when it exists and has not expired by then. */
export function hasValidCredential(
  ctx: RuleContext,
  nurseId: Id,
  credentialId: Id,
  onDate: IsoDate,
): boolean {
  const held = ctx.nurseCredentials.get(nurseId);
  if (!held) return false;
  return held.some((record) => isCredentialValidOn(record, credentialId, onDate));
}

/**
 * A credential lapses the day *after* its expiry date: a card "valid through the 10th" covers a
 * shift on the 10th. The one definition, shared by the rules and the publish alerts — the alerts
 * once counted the expiry day as lapsed, so a grid with no violation published "critical".
 */
export function credentialLapsedOn(record: NurseCredential, onDate: IsoDate): boolean {
  return !!record.expiresOn && compareDates(record.expiresOn, onDate) < 0;
}

function isCredentialValidOn(record: NurseCredential, credentialId: Id, onDate: IsoDate): boolean {
  if (record.credentialId !== credentialId) return false;
  if (record.issuedOn && compareDates(record.issuedOn, onDate) > 0) return false;
  return !credentialLapsedOn(record, onDate);
}

// ---------------------------------------------------------------------------
// Coverage minimums, charge nurse, credentials, skill mix
// ---------------------------------------------------------------------------

export interface CoverageParams {
  /** Every bedside shift needs a designated charge nurse. */
  requireChargeNurse: boolean;
  /**
   * At least this many experienced RNs on the unit during any shift a new grad works: on that
   * shift or, for a shift inside another, on the containing one. Only an RN can supervise an
   * RN, so an experienced LVN or nursing assistant does not count.
   */
  minExperiencedPerShift: number;
  /** Enforce the credential requirements configured for the unit. */
  enforceCredentialRequirements: boolean;
}

export const coverageRule: Rule<CoverageParams> = {
  id: 'coverage-minimums',
  name: 'Coverage minimums and skill mix',
  description:
    'Every shift must meet its baseline staffing floor for each role, have a designated charge ' +
    'nurse, satisfy credential requirements, and never leave a new grad without an experienced ' +
    'RN. A shift inside another is covered by the containing shift: no charge nurse of its own, ' +
    'and that shift’s staff count toward its credentials and new-grad cover.',
  severity: 'hard',
  category: 'coverage',
  scope: 'shift',
  defaultParams: {
    requireChargeNurse: true,
    minExperiencedPerShift: 1,
    enforceCredentialRequirements: true,
  },
  paramDocs: {
    requireChargeNurse: {
      label: 'Require a charge nurse',
      hint: 'Every standalone shift must have one nurse marked as charge.',
      why:
        'Leave this on unless your unit does not assign a charge nurse per shift. Shifts that ' +
        "run inside another use that shift's charge nurse.",
    },
    minExperiencedPerShift: {
      label: 'Experienced RNs with a new grad',
      hint: 'Experienced RNs who must be on the unit whenever a new grad works.',
      why:
        'One is the usual minimum. Raise it while a large new-grad cohort is on orientation. ' +
        'Only RNs count; an experienced LPN or nursing assistant cannot supervise an RN.',
    },
    enforceCredentialRequirements: {
      label: 'Enforce credential requirements',
      hint: 'Shifts must have the credentials set for them, such as an ACLS-certified nurse.',
      why:
        'Leave this on. Turn it off only while credential records are still being entered, so ' +
        'missing data does not block every schedule.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];

    for (const date of schedule.dates) {
      for (const shiftType of ctx.shiftTypes) {
        if (!shiftType.active) continue;
        const demand = ctx.demand.get(date, shiftType.id);
        if (!demand) continue;

        const assigned = schedule.onShift(date, shiftType.id);
        // Whoever else is on the unit during this shift's hours: the containing shift's roster.
        const cover = coveringShift(shiftType, date, schedule.shiftTypesById);
        const onUnit = cover
          ? [...assigned, ...schedule.rosterAt(cover.date, cover.shiftType.id)]
          : assigned;
        const requiresStaff = NURSE_ROLES.some((r) => (demand.byRole[r]?.minCount ?? 0) > 0);

        // --- Baseline floor per role -------------------------------------
        for (const role of NURSE_ROLES) {
          const roleDemand = demand.byRole[role];
          if (!roleDemand || roleDemand.coverageFloorMin <= 0) continue;
          const staffed = countRole(assigned, role);
          if (staffed >= roleDemand.coverageFloorMin) continue;

          violations.push(
            violation(
              coverageRule,
              'hard',
              'understaffed',
              `${shiftType.name} on ${describeDate(date)} has ${staffed} ${role}${staffed === 1 ? '' : 's'}, ` +
                `below the baseline of ${roleDemand.coverageFloorMin}.`,
              {
                dates: [date],
                nurseIds: assigned.map((v) => v.nurse.id),
                assignmentIds: assigned.map((v) => v.assignment.id),
                details: {
                  role,
                  staffed,
                  required: roleDemand.coverageFloorMin,
                  shortfall: roleDemand.coverageFloorMin - staffed,
                  shiftTypeId: shiftType.id,
                  standard: 'coverage_floor',
                },
              },
            ),
          );
        }

        if (!requiresStaff || shiftType.isOnCall) continue;

        // --- Charge nurse -------------------------------------------------
        if (
          params.requireChargeNurse &&
          shiftType.withinShiftTypeId === null &&
          assigned.length > 0
        ) {
          const charge = assigned.filter((v) => v.assignment.isCharge && v.nurse.isChargeEligible);
          if (charge.length === 0) {
            violations.push(
              violation(
                coverageRule,
                'hard',
                'missing_charge_nurse',
                `${shiftType.name} on ${describeDate(date)} has no designated charge nurse.`,
                {
                  dates: [date],
                  nurseIds: assigned.map((v) => v.nurse.id),
                  assignmentIds: assigned.map((v) => v.assignment.id),
                  details: { shiftTypeId: shiftType.id },
                },
              ),
            );
          }
        }

        // --- Skill mix ----------------------------------------------------
        const hasNovice = assigned.some((v) => v.nurse.isNovice);
        if (params.minExperiencedPerShift > 0 && hasNovice) {
          const experienced = onUnit.filter(
            (v) => v.nurse.role === 'RN' && !v.nurse.isNovice,
          ).length;
          if (experienced < params.minExperiencedPerShift) {
            violations.push(
              violation(
                coverageRule,
                'hard',
                'all_novice_shift',
                `${shiftType.name} on ${describeDate(date)} has a new grad with ${experienced} experienced ` +
                  `RN${experienced === 1 ? '' : 's'} on the unit; ${params.minExperiencedPerShift} required.`,
                {
                  dates: [date],
                  nurseIds: assigned.map((v) => v.nurse.id),
                  assignmentIds: assigned.map((v) => v.assignment.id),
                  details: {
                    experienced,
                    required: params.minExperiencedPerShift,
                    shiftTypeId: shiftType.id,
                  },
                },
              ),
            );
          }
        }

        // --- Credentials --------------------------------------------------
        if (params.enforceCredentialRequirements && assigned.length > 0) {
          for (const requirement of ctx.shiftCredentialRequirements) {
            if (requirement.shiftTypeId !== null && requirement.shiftTypeId !== shiftType.id)
              continue;

            const eligible = onUnit.filter(
              (v) => requirement.role === null || v.nurse.role === requirement.role,
            );
            const holders = eligible.filter((v) =>
              hasValidCredential(ctx, v.nurse.id, requirement.credentialId, date),
            );
            if (holders.length >= requirement.minCount) continue;

            const credential = ctx.credentialsById.get(requirement.credentialId);
            const label = credential?.code ?? requirement.credentialId;
            const scope = requirement.role ? `${requirement.role}s` : 'nurses';

            violations.push(
              violation(
                coverageRule,
                'hard',
                'missing_credential',
                `${shiftType.name} on ${describeDate(date)} has ${holders.length} ${label}-certified ${scope}; ` +
                  `${requirement.minCount} required.`,
                {
                  dates: [date],
                  nurseIds: assigned.map((v) => v.nurse.id),
                  assignmentIds: assigned.map((v) => v.assignment.id),
                  details: {
                    credentialId: requirement.credentialId,
                    credentialCode: label,
                    held: holders.length,
                    required: requirement.minCount,
                    role: requirement.role,
                    shiftTypeId: shiftType.id,
                  },
                },
              ),
            );
          }
        }
      }
    }

    return violations;
  },
};

// ---------------------------------------------------------------------------
// Patient ratio compliance
// ---------------------------------------------------------------------------

export interface RatioParams {
  /**
   * Whether a forecast-free shift is exempt. Without a census forecast there is no ratio to
   * check, and treating "unknown" as "compliant" is the only honest option — the day-of
   * console re-checks against actual census anyway.
   */
  skipShiftsWithoutForecast: boolean;
}

export const ratioComplianceRule: Rule<RatioParams> = {
  id: 'patient-ratio-compliance',
  name: 'Patient-to-nurse ratio compliance',
  description:
    'Staffing must satisfy the patients-per-nurse ceilings implied by the projected census and ' +
    'acuity mix. A breach is a regulatory exposure, not a preference.',
  severity: 'hard',
  category: 'safety',
  scope: 'shift',
  defaultParams: { skipShiftsWithoutForecast: true },
  paramDocs: {
    skipShiftsWithoutForecast: {
      label: 'Skip shifts with no census forecast',
      hint: 'A shift with no forecast census is not checked against ratios.',
      why:
        'Leave this on: with no census there is nothing to divide. The coverage floors still ' +
        'apply, and the Today page re-checks ratios against the actual census.',
    },
  },

  evaluate(schedule, params, ctx): Violation[] {
    const violations: Violation[] = [];

    for (const date of schedule.dates) {
      for (const shiftType of ctx.shiftTypes) {
        if (!shiftType.active || shiftType.isOnCall) continue;
        const demand = ctx.demand.get(date, shiftType.id);
        if (!demand) continue;
        if (params.skipShiftsWithoutForecast && demand.fromCoverageFloorOnly) continue;

        const assigned = schedule.onShift(date, shiftType.id);

        for (const role of NURSE_ROLES) {
          const roleDemand = demand.byRole[role];
          if (!roleDemand || roleDemand.ratioDerived <= 0) continue;
          const staffed = countRole(assigned, role);
          if (staffed >= roleDemand.ratioDerived) continue;

          // A charge nurse without patients is on the shift but not at the bedside. Relief
          // nurses carry patients outside the breaks they cover, so they stay in the divisor.
          const bedside = Math.max(0, staffed - roleDemand.chargeWithoutPatients);
          const perNurse = bedside > 0 ? (demand.projectedCensus / bedside).toFixed(1) : '∞';
          const across =
            roleDemand.chargeWithoutPatients > 0
              ? `${staffed} ${role}${staffed === 1 ? '' : 's'}, ${bedside} at the bedside`
              : `${staffed} ${role}${staffed === 1 ? '' : 's'}`;
          violations.push(
            violation(
              ratioComplianceRule,
              'hard',
              'ratio_breach',
              `${shiftType.name} on ${describeDate(date)}: ${demand.projectedCensus} projected patients across ` +
                `${across} is ${perNurse} patients per nurse. ` +
                `The acuity mix requires ${roleDemand.ratioDerived}${ratioMakeup(roleDemand)}.`,
              {
                dates: [date],
                nurseIds: assigned.map((v) => v.nurse.id),
                assignmentIds: assigned.map((v) => v.assignment.id),
                details: {
                  role,
                  staffed,
                  required: roleDemand.ratioDerived,
                  shortfall: roleDemand.ratioDerived - staffed,
                  projectedCensus: demand.projectedCensus,
                  patientsPerNurse: bedside > 0 ? demand.projectedCensus / bedside : null,
                  ratioBedside: roleDemand.ratioBedside,
                  chargeWithoutPatients: roleDemand.chargeWithoutPatients,
                  breakRelief: roleDemand.breakRelief,
                  shiftTypeId: shiftType.id,
                  standard: 'ratio',
                },
              },
            ),
          );
        }
      }
    }

    return violations;
  },
};

/** " (4 at the bedside and a charge nurse without patients)" — empty when the ratio is all bedside. */
function ratioMakeup(demand: RoleDemand): string {
  const extras: string[] = [];
  if (demand.chargeWithoutPatients > 0) extras.push('a charge nurse without patients');
  if (demand.breakRelief > 0) extras.push(`${demand.breakRelief} to relieve breaks`);
  if (extras.length === 0) return '';
  return ` (${demand.ratioBedside} at the bedside and ${extras.join(' and ')})`;
}

function countRole(assigned: readonly AssignmentView[], role: NurseRole): number {
  let count = 0;
  for (const view of assigned) if (view.nurse.role === role) count++;
  return count;
}

/** Staffing shortfall per role for one shift, used by conflict detection and the solver. */
export function shortfallsForShift(
  schedule: ScheduleView,
  ctx: RuleContext,
  date: IsoDate,
  shiftTypeId: Id,
): { role: NurseRole; staffed: number; required: number; shortfall: number }[] {
  const demand = ctx.demand.get(date, shiftTypeId);
  if (!demand) return [];
  const assigned = schedule.onShift(date, shiftTypeId);
  const out: { role: NurseRole; staffed: number; required: number; shortfall: number }[] = [];
  for (const role of NURSE_ROLES) {
    const required = demand.byRole[role]?.minCount ?? 0;
    if (required <= 0) continue;
    const staffed = countRole(assigned, role);
    if (staffed < required) out.push({ role, staffed, required, shortfall: required - staffed });
  }
  return out;
}
