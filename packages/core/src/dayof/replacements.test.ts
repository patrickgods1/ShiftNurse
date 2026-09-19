/**
 * A charge nurse gets a call-off at 05:40 and needs the ranked list of who can legally take the
 * shift right now, plus a plain answer for anyone asking why they aren't on it.
 */

import { describe, expect, it } from 'vitest';
import type { FairnessLedgerEntry } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  CRED_ACLS,
  coverage,
  credentialRequirement,
  DAY_12,
  makeNurse,
  NIGHT_12,
  nurseCredential,
  overtimeRule,
  payRate,
  resetFixtureCounters,
  type SolveScenarioOptions,
  solveInputFrom,
  timeOff,
} from '../testing/fixtures.js';
import { findReplacements } from './replacements.js';
import type { ReplacementInput } from './types.js';

const START = isoDate('2026-01-05'); // a Monday
const END = isoDate('2026-01-17');
const SAT = isoDate('2026-01-10');
const FRI = isoDate('2026-01-09');

/** A two-week period with the given extras layered on; no coverage floor unless stated. */
function replacementInput(
  extra: Partial<SolveScenarioOptions> & {
    absentAssignmentId: string;
    lastCalledAt?: Record<string, number>;
  },
): ReplacementInput {
  const { absentAssignmentId, lastCalledAt, ...rest } = extra;
  return {
    ...solveInputFrom({ startDate: START, endDate: END, shiftTypes: [DAY_12, NIGHT_12], ...rest }),
    absentAssignmentId,
    lastCalledAt: lastCalledAt ?? {},
  };
}

let ledgerCounter = 0;

function ledgerRow(
  nurseId: string,
  periodStart: string,
  overrides: Partial<FairnessLedgerEntry> = {},
): FairnessLedgerEntry {
  ledgerCounter++;
  return {
    id: `ledger-${ledgerCounter}`,
    nurseId,
    periodId: `hist-${ledgerCounter}`,
    periodStart: isoDate(periodStart),
    nightShifts: 0,
    weekendsWorked: 0,
    holidaysWorked: 0,
    onCallShifts: 0,
    undesirableShifts: 0,
    requestsApproved: 0,
    requestsDenied: 0,
    callOutsCovered: 0,
    totalHours: 0,
    overtimeHours: 0,
    preferenceHitRate: 0,
    ...overrides,
  };
}

describe('findReplacements', () => {
  it('excludes the nurse whose Friday night ends when this Saturday day shift starts', () => {
    resetFixtureCounters();
    const absent = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const nightNurse = makeNurse({ firstName: 'Ben', lastName: 'Ortiz' });

    const absentShift = assign(absent.id, DAY_12, SAT);
    // Ben's Friday night runs 19:00 Fri -> 07:00 Sat, exactly when the Saturday day shift starts.
    const fridayNight = assign(nightNurse.id, NIGHT_12, FRI);

    const input = replacementInput({
      nurses: [absent, nightNurse],
      assignments: [absentShift, fridayNight],
      absentAssignmentId: absentShift.id,
    });

    const report = findReplacements(input);

    const excludedBen = report.excluded.find((e) => e.nurseId === nightNurse.id);
    expect(excludedBen).toBeDefined();
    expect(excludedBen!.reason).toMatch(/minimum rest/i);
    expect(report.candidates.some((c) => c.nurseId === nightNurse.id)).toBe(false);
  });

  it('excludes a nurse without the credential the shift requires', () => {
    resetFixtureCounters();
    const absent = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const noCred = makeNurse({ firstName: 'Wes', lastName: 'Tran' });
    const withCred = makeNurse({ firstName: 'Ana', lastName: 'Cruz' });

    const absentShift = assign(absent.id, DAY_12, SAT);

    const input = replacementInput({
      nurses: [absent, noCred, withCred],
      assignments: [absentShift],
      // A floor > 0 is what turns on the coverage rule's credential check at all.
      coverageRequirements: [coverage(DAY_12, 'RN', 1, 1, null, SAT)],
      shiftCredentialRequirements: [credentialRequirement(CRED_ACLS, 1, { shiftType: DAY_12 })],
      // The absent nurse held ACLS too, so the baseline itself is clean and only the
      // replacement's own credential is what the diff can catch.
      nurseCredentials: [
        nurseCredential(absent.id, CRED_ACLS),
        nurseCredential(withCred.id, CRED_ACLS),
      ],
      absentAssignmentId: absentShift.id,
    });

    const report = findReplacements(input);

    const excludedWes = report.excluded.find((e) => e.nurseId === noCred.id);
    expect(excludedWes).toBeDefined();
    expect(excludedWes!.reason).toMatch(/acls/i);
    expect(report.candidates.some((c) => c.nurseId === withCred.id)).toBe(true);
    expect(report.candidates.some((c) => c.nurseId === noCred.id)).toBe(false);
  });

  it('excludes a nurse already working that day and one on approved leave', () => {
    resetFixtureCounters();
    const absent = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const busy = makeNurse({ firstName: 'Tom', lastName: 'Reed' });
    const onLeave = makeNurse({ firstName: 'Nina', lastName: 'Alvarez' });

    const absentShift = assign(absent.id, DAY_12, SAT);
    const busyShift = assign(busy.id, NIGHT_12, SAT);

    const input = replacementInput({
      nurses: [absent, busy, onLeave],
      assignments: [absentShift, busyShift],
      timeOff: [timeOff(onLeave.id, SAT, SAT)],
      absentAssignmentId: absentShift.id,
    });

    const report = findReplacements(input);

    const excludedBusy = report.excluded.find((e) => e.nurseId === busy.id);
    const excludedOnLeave = report.excluded.find((e) => e.nurseId === onLeave.id);
    expect(excludedBusy!.reason).toMatch(/Already scheduled on 2026-01-10/);
    expect(excludedOnLeave!.reason).toBe('On approved leave');
  });

  it('never lists a nurse of a different role, in either list', () => {
    resetFixtureCounters();
    const absent = makeNurse({ firstName: 'Priya', lastName: 'Nair', role: 'RN' });
    const lpn = makeNurse({ firstName: 'Leo', lastName: 'Park', role: 'LPN' });

    const absentShift = assign(absent.id, DAY_12, SAT);

    const input = replacementInput({
      nurses: [absent, lpn],
      assignments: [absentShift],
      absentAssignmentId: absentShift.id,
    });

    const report = findReplacements(input);

    expect(report.candidates.some((c) => c.nurseId === lpn.id)).toBe(false);
    expect(report.excluded.some((e) => e.nurseId === lpn.id)).toBe(false);
  });

  it('orders straight time before overtime before agency', () => {
    resetFixtureCounters();
    const absent = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const idle = makeNurse({ firstName: 'Ana', lastName: 'Cruz' });
    const nearOt = makeNurse({ firstName: 'Ben', lastName: 'Ortiz' });
    const agency = makeNurse({ firstName: 'Cy', lastName: 'Farah', employmentType: 'agency' });

    const absentShift = assign(absent.id, DAY_12, SAT);
    // Ben's week (starting Sunday 2026-01-04) already has 36h Mon-Wed; picking up Saturday's
    // 12h crosses the 40h weekly threshold, so this is only legal as authorised overtime.
    const alreadyWorked = [
      assign(nearOt.id, DAY_12, '2026-01-05'),
      assign(nearOt.id, DAY_12, '2026-01-06'),
      assign(nearOt.id, DAY_12, '2026-01-07'),
    ];

    const input = replacementInput({
      nurses: [absent, idle, nearOt, agency],
      assignments: [absentShift, ...alreadyWorked],
      cost: {
        payRates: [payRate(50)],
        differentials: [],
        overtimeRules: [overtimeRule('weekly', 40)],
      },
      absentAssignmentId: absentShift.id,
    });

    const report = findReplacements(input);

    expect(report.candidates.map((c) => c.nurseId)).toEqual([idle.id, nearOt.id, agency.id]);
    expect(report.candidates.map((c) => c.payTier)).toEqual(['straight', 'overtime', 'agency']);
    expect(report.candidates.find((c) => c.nurseId === nearOt.id)!.assignment.isOvertime).toBe(
      true,
    );
    expect(report.candidates.find((c) => c.nurseId === idle.id)!.assignment.isOvertime).toBe(false);
  });

  it('within a tier, calls the nurse who has been called least recently first', () => {
    resetFixtureCounters();
    const absent = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const neverCalled = makeNurse({ firstName: 'Ana', lastName: 'Cruz' });
    const calledRecently = makeNurse({ firstName: 'Tom', lastName: 'Reed' });
    const calledLongAgo = makeNurse({ firstName: 'Nina', lastName: 'Alvarez' });

    const absentShift = assign(absent.id, DAY_12, SAT);

    const input = replacementInput({
      nurses: [absent, neverCalled, calledRecently, calledLongAgo],
      assignments: [absentShift],
      lastCalledAt: {
        [calledRecently.id]: Date.parse('2026-01-08T00:00:00Z'),
        [calledLongAgo.id]: Date.parse('2026-01-01T00:00:00Z'),
      },
      absentAssignmentId: absentShift.id,
    });

    const report = findReplacements(input);

    expect(report.candidates.map((c) => c.nurseId)).toEqual([
      neverCalled.id,
      calledLongAgo.id,
      calledRecently.id,
    ]);
  });

  it('within a tier, prefers the nurse who has carried less', () => {
    resetFixtureCounters();
    const absent = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const lightlyLoaded = makeNurse({ firstName: 'Ana', lastName: 'Cruz' });
    const heavilyLoaded = makeNurse({ firstName: 'Tom', lastName: 'Reed' });

    const absentShift = assign(absent.id, DAY_12, SAT);

    const input = replacementInput({
      nurses: [absent, lightlyLoaded, heavilyLoaded],
      assignments: [absentShift],
      ledgerHistory: [
        ledgerRow(heavilyLoaded.id, '2026-01-01', { nightShifts: 12, weekendsWorked: 6 }),
        ledgerRow(lightlyLoaded.id, '2026-01-01', { nightShifts: 0, weekendsWorked: 0 }),
      ],
      absentAssignmentId: absentShift.id,
    });

    const report = findReplacements(input);

    expect(report.candidates.map((c) => c.nurseId)).toEqual([lightlyLoaded.id, heavilyLoaded.id]);
    expect(report.candidates[0]!.burdenIndex).toBeLessThan(report.candidates[1]!.burdenIndex);
  });

  it('the candidate row is a callout that a backfill can write as-is', () => {
    resetFixtureCounters();
    const absent = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const idle = makeNurse({ firstName: 'Ana', lastName: 'Cruz' });

    const absentShift = assign(absent.id, DAY_12, SAT);

    const input = replacementInput({
      nurses: [absent, idle],
      assignments: [absentShift],
      absentAssignmentId: absentShift.id,
    });

    const report = findReplacements(input);

    const candidate = report.candidates.find((c) => c.nurseId === idle.id)!;
    expect(candidate.assignment.source).toBe('callout');
    expect(candidate.assignment.nurseId).toBe(idle.id);
    expect(candidate.assignment.date).toBe(SAT);
    expect(candidate.assignment.shiftTypeId).toBe(DAY_12.id);
    expect(candidate.assignment.isLocked).toBe(false);
  });

  it('reports how short the shift is with the absent nurse gone', () => {
    resetFixtureCounters();
    const absent = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const stays = makeNurse({ firstName: 'Ana', lastName: 'Cruz' });

    const absentShift = assign(absent.id, DAY_12, SAT);
    const staysShift = assign(stays.id, DAY_12, SAT);

    const input = replacementInput({
      nurses: [absent, stays],
      assignments: [absentShift, staysShift],
      coverageRequirements: [coverage(DAY_12, 'RN', 2, 2, null, SAT)],
      absentAssignmentId: absentShift.id,
    });

    const report = findReplacements(input);

    expect(report.shortfall).toBe(1);
  });

  it('refuses an assignment that is history', () => {
    resetFixtureCounters();
    const nurse = makeNurse({ firstName: 'Priya', lastName: 'Nair' });
    const historic = assign(nurse.id, DAY_12, '2026-01-03', { id: 'history-1' });

    const input = replacementInput({
      nurses: [nurse],
      assignments: [],
      priorAssignments: [historic],
      absentAssignmentId: historic.id,
    });

    expect(() => findReplacements(input)).toThrow(/history/i);
  });
});
