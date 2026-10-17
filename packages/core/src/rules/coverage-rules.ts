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

import { NURSE_ROLES, type RoleDemand, type ShiftDemand } from '../acuity/demand.js';
import type { Id, Nurse, NurseCredential, NurseRole } from '../domain/entities.js';
import { compareDates, describeDate, type IsoDate } from '../domain/time.js';
import { coveringShift } from '../schedule/cover.js';
import type { AssignmentView } from '../schedule/view.js';
import { nurseName, type Rule, type RuleContext, type Violation, violation } from './types.js';

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
  /** Only an RN may be marked charge; off lets any charge-eligible nurse (an LPN/LVN) run it. */
  chargeMustBeRN: boolean;
  /**
   * At least this many experienced RNs on the unit during any shift a new grad works: on that
   * shift or, for a shift inside another, on the containing one. Only an RN can supervise an
   * RN, so an experienced LVN or nursing assistant does not count.
   */
  minExperiencedPerShift: number;
  /** Enforce the credential requirements configured for the unit. */
  enforceCredentialRequirements: boolean;
}

/**
 * Whether a nurse may be marked charge. The one definition: the rule judges a flag by it and both
 * solvers hand the flag out by it, so neither can emit a charge nurse the rule then rejects.
 */
export function canTakeCharge(
  nurse: Pick<Nurse, 'isChargeEligible' | 'role'>,
  params: Pick<CoverageParams, 'chargeMustBeRN'>,
): boolean {
  return nurse.isChargeEligible && (!params.chargeMustBeRN || nurse.role === 'RN');
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
    chargeMustBeRN: true,
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
    chargeMustBeRN: {
      label: 'Charge nurse must be an RN',
      hint: 'Only a charge-eligible RN may be marked charge.',
      why:
        'Most contracts and state rules have an RN run the shift. Turn it off if your unit lets ' +
        'a charge-eligible LPN or LVN take charge.',
      activeWhen: { param: 'requireChargeNurse', equals: true },
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
                amount: roleDemand.coverageFloorMin - staffed,
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
          const flagged = assigned.filter((v) => v.assignment.isCharge);
          const where = `${shiftType.name} on ${describeDate(date)}`;
          if (!flagged.some((v) => canTakeCharge(v.nurse, params))) {
            violations.push(
              violation(
                coverageRule,
                'hard',
                'missing_charge_nurse',
                flagged.length === 0
                  ? `${where} has no designated charge nurse.`
                  : `${where} has no charge nurse who can take charge: ${whyNotCharge(flagged, params)}.`,
                {
                  amount: 1,
                  dates: [date],
                  nurseIds: assigned.map((v) => v.nurse.id),
                  assignmentIds: assigned.map((v) => v.assignment.id),
                  details: {
                    shiftTypeId: shiftType.id,
                    flaggedNurseIds: flagged.map((v) => v.nurse.id),
                  },
                },
              ),
            );
          }
          // No `shortfall` detail: SA prices a hard shift finding without one at 1, whatever
          // the count, and CP-SAT's locked double-charge constant is set to match.
          if (flagged.length > 1) {
            violations.push(
              violation(
                coverageRule,
                'hard',
                'multiple_charge_nurses',
                `${where} has ${flagged.length} nurses marked charge ` +
                  `(${listNames(flagged)}); one runs the shift.`,
                {
                  amount: flagged.length - 1,
                  dates: [date],
                  nurseIds: assigned.map((v) => v.nurse.id),
                  assignmentIds: assigned.map((v) => v.assignment.id),
                  details: { shiftTypeId: shiftType.id, chargeCount: flagged.length },
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
                  amount: params.minExperiencedPerShift - experienced,
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
                  amount: requirement.minCount - holders.length,
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
                amount: roleDemand.ratioDerived - staffed,
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

        if (demand.licensed) {
          violations.push(
            ...licensedBreaches(demand, assigned, shiftType.name, date, shiftType.id),
          );
        }
      }
    }

    return violations;
  },
};

/**
 * A `licensed` ratio's two checks: RNs alone against the share the rule requires, and RNs and
 * LPN/LVNs together against the pooled count. Every RN the share needs also counts toward the pool,
 * so the pooled breach reports only what is left after them — one RN and one LVN against "four,
 * two of them RNs" is one RN and one more of either, two nurses, not three. Each breach carries its
 * shortfall, which is what both solvers price, so the total is the fewest nurses that fix it.
 */
function licensedBreaches(
  demand: ShiftDemand,
  assigned: readonly AssignmentView[],
  shiftName: string,
  date: IsoDate,
  shiftTypeId: Id,
): Violation[] {
  const licensed = demand.licensed!;
  const rns = countRole(assigned, 'RN');
  const lvns = countRole(assigned, 'LPN');
  const staffed = rns + lvns;
  const where = `${shiftName} on ${describeDate(date)}`;
  const parts = {
    dates: [date],
    nurseIds: assigned.map((v) => v.nurse.id),
    assignmentIds: assigned.map((v) => v.assignment.id),
  };
  const out: Violation[] = [];
  const rnShort = Math.max(0, licensed.minRn - rns);
  const poolShort = Math.max(0, licensed.ratioDerived - staffed);
  const poolExtra = poolShort - Math.min(poolShort, rnShort);
  if (poolExtra > 0) {
    const bedside = Math.max(0, staffed - licensed.chargeWithoutPatients);
    const perNurse = bedside > 0 ? (demand.projectedCensus / bedside).toFixed(1) : '∞';
    out.push(
      violation(
        ratioComplianceRule,
        'hard',
        'ratio_breach',
        `${where}: ${demand.projectedCensus} projected patients across ${staffed} licensed nurses ` +
          `(${rns} RN${rns === 1 ? '' : 's'}, ${lvns} LVN${lvns === 1 ? '' : 's'}) is ${perNurse} ` +
          `patients per nurse. The licensed ratio requires ${licensed.ratioDerived}` +
          (rnShort > 0 ? `: ${poolExtra} more of either after the RNs below.` : '.'),
        {
          ...parts,
          amount: poolExtra,
          details: {
            role: 'licensed',
            staffed,
            required: licensed.ratioDerived,
            shortfall: poolExtra,
            projectedCensus: demand.projectedCensus,
            shiftTypeId,
            standard: 'ratio',
          },
        },
      ),
    );
  }
  if (rnShort > 0) {
    const share = Math.round((licensed.minRn / Math.max(1, licensed.ratioDerived)) * 100);
    out.push(
      violation(
        ratioComplianceRule,
        'hard',
        'ratio_breach',
        `${where}: ${rns} of ${staffed} licensed nurses ${rns === 1 ? 'is an RN' : 'are RNs'}; ` +
          `at least ${licensed.minRn} must be (${share}%).`,
        {
          ...parts,
          amount: rnShort,
          details: {
            role: 'RN',
            staffed: rns,
            required: licensed.minRn,
            shortfall: rnShort,
            shiftTypeId,
            standard: 'rn_share',
          },
        },
      ),
    );
  }
  return out;
}

/** " (4 at the bedside and a charge nurse without patients)" — empty when the ratio is all bedside. */
function ratioMakeup(demand: RoleDemand): string {
  const extras: string[] = [];
  if (demand.chargeWithoutPatients > 0) extras.push('a charge nurse without patients');
  if (demand.breakRelief > 0) extras.push(`${demand.breakRelief} to relieve breaks`);
  if (extras.length === 0) return '';
  return ` (${demand.ratioBedside} at the bedside and ${extras.join(' and ')})`;
}

function listNames(views: readonly AssignmentView[]): string {
  const names = views.map((v) => nurseName(v.nurse));
  return names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/**
 * "Lena Ortiz is marked charge but is not an RN" — for nurses marked charge of whom none may take
 * it. A manager fixing the shift needs to know whether to change the flag or the nurse's record.
 */
function whyNotCharge(
  flagged: readonly AssignmentView[],
  params: Pick<CoverageParams, 'chargeMustBeRN'>,
): string {
  const notEligible = flagged.every((v) => !v.nurse.isChargeEligible);
  const notRn = params.chargeMustBeRN && flagged.every((v) => v.nurse.isChargeEligible);
  if (flagged.length === 1) {
    return `${listNames(flagged)} is marked charge but ${notRn ? 'is not an RN' : 'is not charge-eligible'}`;
  }
  const reason = notEligible
    ? 'are not charge-eligible'
    : notRn
      ? 'are not RNs'
      : 'none is a charge-eligible RN';
  return `${listNames(flagged)} are marked charge but ${reason}`;
}

function countRole(assigned: readonly AssignmentView[], role: NurseRole): number {
  let count = 0;
  for (const view of assigned) if (view.nurse.role === role) count++;
  return count;
}
