/**
 * Row ↔ domain entity conversion.
 *
 * Two impedance mismatches make this layer necessary rather than incidental:
 *
 * 1. **`null` vs `undefined`.** SQL has one absent value; the domain interfaces use optional
 *    properties. Leaking `null` into `packages/core` would force every rule to test for both.
 * 2. **The `Preference` discriminated union.** It is four shapes with different payloads,
 *    stored as one table with nullable columns. Reassembling the correct variant — and
 *    failing loudly on a row that matches none — belongs here, not in the rule engine.
 *
 * Keeping this conversion in one place is what lets `packages/core` stay free of any
 * knowledge that a database exists.
 */

import type {
  AcuityTier,
  Assignment,
  Budget,
  CallAttempt,
  CallOff,
  CensusForecast,
  CoverageRequirement,
  Credential,
  Differential,
  FairnessLedgerEntry,
  Holiday,
  Id,
  IsoDate,
  Nurse,
  NurseCredential,
  OvertimeRule,
  PayRate,
  Preference,
  RatioRule,
  ScheduleChange,
  SchedulePeriod,
  ScheduleVersion,
  ShiftCredentialRequirement,
  ShiftSwap,
  ShiftType,
  TimeOffRequest,
  Unit,
  Weekday,
} from '@shiftnurse/core';
import type * as s from './schema.js';

/** SQL `NULL` becomes an absent optional property. */
function opt<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export function toUnit(r: typeof s.unit.$inferSelect): Unit {
  return {
    id: r.id,
    name: r.name,
    unitType: r.unitType,
    payPeriodDays: r.payPeriodDays,
    payPeriodAnchor: r.payPeriodAnchor as Unit['payPeriodAnchor'],
  };
}

export function toShiftType(r: typeof s.shiftType.$inferSelect): ShiftType {
  return {
    id: r.id,
    unitId: r.unitId,
    name: r.name,
    abbreviation: r.abbreviation,
    startTime: r.startTime,
    durationHours: r.durationHours,
    isNight: r.isNight,
    isOnCall: r.isOnCall,
    color: r.color,
    sortOrder: r.sortOrder,
    active: r.active,
  };
}

export function toNurse(r: typeof s.nurse.$inferSelect): Nurse {
  return {
    id: r.id,
    unitId: r.unitId,
    employeeId: r.employeeId,
    firstName: r.firstName,
    lastName: r.lastName,
    role: r.role,
    employmentType: r.employmentType,
    fte: r.fte,
    contractedHoursPerPeriod: r.contractedHoursPerPeriod,
    seniorityDate: r.seniorityDate as Nurse['seniorityDate'],
    isChargeEligible: r.isChargeEligible,
    isNovice: r.isNovice,
    isFloatEligible: r.isFloatEligible,
    phone: opt(r.phone),
    email: opt(r.email),
    active: r.active,
    notes: opt(r.notes),
  };
}

export function toCredential(r: typeof s.credential.$inferSelect): Credential {
  return { id: r.id, code: r.code, name: r.name, tracksExpiry: r.tracksExpiry };
}

export function toNurseCredential(r: typeof s.nurseCredential.$inferSelect): NurseCredential {
  return {
    id: r.id,
    nurseId: r.nurseId,
    credentialId: r.credentialId,
    issuedOn: opt(r.issuedOn) as NurseCredential['issuedOn'],
    expiresOn: opt(r.expiresOn) as NurseCredential['expiresOn'],
  };
}

export function toCredentialRequirement(
  r: typeof s.shiftCredentialRequirement.$inferSelect,
): ShiftCredentialRequirement {
  return {
    id: r.id,
    unitId: r.unitId,
    shiftTypeId: r.shiftTypeId,
    role: r.role,
    credentialId: r.credentialId,
    minCount: r.minCount,
  };
}

/**
 * Reassemble a preference row into its union variant.
 *
 * Throws on a row whose payload column for its `kind` is null. That is a corrupt row, and a
 * silently dropped preference means a nurse's stated wishes quietly stop counting — exactly
 * the kind of invisible unfairness this app exists to prevent.
 */
export function toPreference(r: typeof s.preference.$inferSelect): Preference {
  const base = { id: r.id, nurseId: r.nurseId, weight: r.weight };
  switch (r.kind) {
    case 'prefer_shift_type':
    case 'avoid_shift_type': {
      if (r.shiftTypeId === null) throw corrupt(r.id, r.kind, 'shiftTypeId');
      return { ...base, kind: r.kind, shiftTypeId: r.shiftTypeId };
    }
    case 'prefer_weekday':
    case 'avoid_weekday': {
      if (r.weekday === null) throw corrupt(r.id, r.kind, 'weekday');
      return { ...base, kind: r.kind, weekday: r.weekday as Weekday };
    }
    case 'weekend_appetite': {
      if (r.level === null) throw corrupt(r.id, r.kind, 'level');
      return { ...base, kind: r.kind, level: r.level };
    }
    case 'preferred_block_length': {
      if (r.blockShifts === null) throw corrupt(r.id, r.kind, 'blockShifts');
      return { ...base, kind: r.kind, shifts: r.blockShifts };
    }
    default: {
      const exhaustive: never = r.kind;
      throw new Error(`Unknown preference kind "${String(exhaustive)}" on row ${r.id}`);
    }
  }
}

function corrupt(id: Id, kind: string, column: string): Error {
  return new Error(`Preference ${id} of kind "${kind}" has a null ${column}; the row is corrupt.`);
}

/** Flatten a preference union back into its row shape. */
export function fromPreference(p: Preference): typeof s.preference.$inferInsert {
  const row = {
    id: p.id,
    nurseId: p.nurseId,
    kind: p.kind,
    weight: p.weight,
    shiftTypeId: null as Id | null,
    weekday: null as number | null,
    level: null as number | null,
    blockShifts: null as number | null,
  };
  switch (p.kind) {
    case 'prefer_shift_type':
    case 'avoid_shift_type':
      return { ...row, shiftTypeId: p.shiftTypeId };
    case 'prefer_weekday':
    case 'avoid_weekday':
      return { ...row, weekday: p.weekday };
    case 'weekend_appetite':
      return { ...row, level: p.level };
    case 'preferred_block_length':
      return { ...row, blockShifts: p.shifts };
  }
}

export function toTimeOffRequest(r: typeof s.timeOffRequest.$inferSelect): TimeOffRequest {
  return {
    id: r.id,
    nurseId: r.nurseId,
    startDate: r.startDate as TimeOffRequest['startDate'],
    endDate: r.endDate as TimeOffRequest['endDate'],
    type: r.type,
    status: r.status,
    enteredBy: r.enteredBy,
    submittedAt: r.submittedAt,
    decidedAt: opt(r.decidedAt),
    decidedBy: opt(r.decidedBy),
    reason: opt(r.reason),
    decisionReason: opt(r.decisionReason),
  };
}

export function toShiftSwap(r: typeof s.shiftSwap.$inferSelect): ShiftSwap {
  return {
    id: r.id,
    periodId: r.periodId,
    kind: r.kind,
    requestingNurseId: r.requestingNurseId,
    counterpartyNurseId: r.counterpartyNurseId,
    offeredAssignmentId: r.offeredAssignmentId,
    requestedAssignmentId: opt(r.requestedAssignmentId),
    status: r.status,
    enteredBy: r.enteredBy,
    submittedAt: r.submittedAt,
    decidedAt: opt(r.decidedAt),
    decidedBy: opt(r.decidedBy),
    reason: opt(r.reason),
    decisionReason: opt(r.decisionReason),
    overrode: r.overrode,
  };
}

export function toScheduleVersion(r: typeof s.scheduleVersion.$inferSelect): ScheduleVersion {
  return {
    id: r.id,
    periodId: r.periodId,
    version: r.version,
    publishedAt: r.publishedAt,
    publishedBy: r.publishedBy,
    reason: opt(r.reason),
    assignments: r.assignments as Assignment[],
    added: r.added,
    removed: r.removed,
    changed: r.changed,
  };
}

export function toScheduleChange(r: typeof s.scheduleChange.$inferSelect): ScheduleChange {
  return {
    id: r.id,
    periodId: r.periodId,
    version: r.version,
    kind: r.kind,
    source: r.source,
    nurseId: r.nurseId,
    date: r.date as ScheduleChange['date'],
    shiftTypeId: r.shiftTypeId,
    assignmentId: r.assignmentId,
    before: (r.before as Assignment | null) ?? undefined,
    after: (r.after as Assignment | null) ?? undefined,
    reason: r.reason,
    actor: r.actor,
    at: r.at,
  };
}

export function toAcuityTier(r: typeof s.acuityTier.$inferSelect): AcuityTier {
  return {
    id: r.id,
    unitId: r.unitId,
    name: r.name,
    level: r.level,
    careHoursPerPatientDay: r.careHoursPerPatientDay,
  };
}

export function toRatioRule(r: typeof s.ratioRule.$inferSelect): RatioRule {
  return {
    id: r.id,
    unitId: r.unitId,
    role: r.role,
    acuityTierId: r.acuityTierId,
    maxPatientsPerNurse: r.maxPatientsPerNurse,
    citation: opt(r.citation),
    active: r.active,
  };
}

export function toCensusForecast(r: typeof s.censusForecast.$inferSelect): CensusForecast {
  return {
    id: r.id,
    unitId: r.unitId,
    date: r.date as CensusForecast['date'],
    shiftTypeId: r.shiftTypeId,
    projectedCensus: r.projectedCensus,
    acuityMix: r.acuityMix,
    actualCensus: opt(r.actualCensus),
    actualAcuityMix: opt(r.actualAcuityMix),
    source: r.source,
  };
}

export function toCoverageRequirement(
  r: typeof s.coverageRequirement.$inferSelect,
): CoverageRequirement {
  return {
    id: r.id,
    unitId: r.unitId,
    shiftTypeId: r.shiftTypeId,
    weekday: (r.weekday ?? null) as Weekday | null,
    date: (r.date ?? null) as CoverageRequirement['date'],
    role: r.role,
    minCount: r.minCount,
    targetCount: r.targetCount,
  };
}

export function toHoliday(r: typeof s.holiday.$inferSelect): Holiday {
  return {
    id: r.id,
    unitId: r.unitId,
    date: r.date as Holiday['date'],
    name: r.name,
    isMajor: r.isMajor,
  };
}

export function toSchedulePeriod(r: typeof s.schedulePeriod.$inferSelect): SchedulePeriod {
  return {
    id: r.id,
    unitId: r.unitId,
    name: r.name,
    startDate: r.startDate as SchedulePeriod['startDate'],
    endDate: r.endDate as SchedulePeriod['endDate'],
    status: r.status,
    publishedAt: opt(r.publishedAt),
    ruleSetId: r.ruleSetId,
    ruleSetVersion: r.ruleSetVersion,
  };
}

export function toAssignment(r: typeof s.assignment.$inferSelect): Assignment {
  return {
    id: r.id,
    periodId: r.periodId,
    nurseId: r.nurseId,
    shiftTypeId: r.shiftTypeId,
    date: r.date as Assignment['date'],
    source: r.source,
    isLocked: r.isLocked,
    isCharge: r.isCharge,
    isOvertime: r.isOvertime,
    notes: opt(r.notes),
  };
}

// ---------------------------------------------------------------------------
// Day-of operations, cost and fairness history
// ---------------------------------------------------------------------------

export function toCallOff(r: typeof s.callOff.$inferSelect): CallOff {
  return {
    id: r.id,
    assignmentId: r.assignmentId,
    periodId: r.periodId,
    nurseId: r.nurseId,
    shiftTypeId: r.shiftTypeId,
    date: r.date,
    reportedAt: r.reportedAt,
    reason: opt(r.reason),
    status: r.status,
    replacementAssignmentId: opt(r.replacementAssignmentId),
  };
}

export function toCallAttempt(r: typeof s.callAttempt.$inferSelect): CallAttempt {
  return {
    id: r.id,
    callOffId: r.callOffId,
    nurseId: r.nurseId,
    attemptedAt: r.attemptedAt,
    outcome: r.outcome,
    notes: opt(r.notes),
  };
}

export function toPayRate(r: typeof s.payRate.$inferSelect): PayRate {
  return {
    id: r.id,
    nurseId: r.nurseId,
    role: r.role,
    hourlyRate: r.hourlyRate,
    effectiveFrom: r.effectiveFrom as IsoDate,
  };
}

export function toDifferential(r: typeof s.differential.$inferSelect): Differential {
  return {
    id: r.id,
    unitId: r.unitId,
    kind: r.kind,
    mode: r.mode,
    amount: r.amount,
    active: r.active,
  };
}

export function toOvertimeRule(r: typeof s.overtimeRule.$inferSelect): OvertimeRule {
  return {
    id: r.id,
    unitId: r.unitId,
    basis: r.basis,
    thresholdHours: r.thresholdHours,
    multiplier: r.multiplier,
    active: r.active,
  };
}

export function toBudget(r: typeof s.budget.$inferSelect): Budget {
  return { id: r.id, unitId: r.unitId, periodId: r.periodId, targetDollars: r.targetDollars };
}

export function toFairnessLedgerEntry(
  r: typeof s.fairnessLedger.$inferSelect,
): FairnessLedgerEntry {
  return {
    id: r.id,
    nurseId: r.nurseId,
    periodId: r.periodId,
    periodStart: r.periodStart as IsoDate,
    nightShifts: r.nightShifts,
    weekendsWorked: r.weekendsWorked,
    holidaysWorked: r.holidaysWorked,
    onCallShifts: r.onCallShifts,
    undesirableShifts: r.undesirableShifts,
    requestsApproved: r.requestsApproved,
    requestsDenied: r.requestsDenied,
    callOutsCovered: r.callOutsCovered,
    totalHours: r.totalHours,
    overtimeHours: r.overtimeHours,
    preferenceHitRate: r.preferenceHitRate,
  };
}
