/**
 * Every kind of audited entry that is about a nurse must reach her grievance record, proved by a
 * real repository writer rather than a hand-built audit row: a writer whose snapshot forgets to
 * name her (as holdovers once did) fails here. The entry kinds themselves are the hand-written
 * `NURSE_SCOPED` list, which `nurse-record.completeness.test.ts` holds against the code.
 *
 * Each case counts the nurse's entries of its type before and after one write. A bare "has one"
 * would pass on the entry that setup itself wrote (her own row, her scheduled shift).
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  type Id,
  isoDate,
  type Nurse,
  type Resolution,
  type ResolutionImpact,
  today,
} from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { logCallAttempt, reportCallOff } from './calloffs.js';
import { recordShiftCancellation } from './cancellations.js';
import { createCompTimeElection, recordCompTimeCredits } from './comp-time.js';
import { createShiftType, createUnit } from './config.js';
import { applyResolution } from './conflicts.js';
import { createDayOfPayEvent } from './day-of-pay.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { proposeSwap } from './exchange.js';
import { createFloatRecord } from './float-records.js';
import { recordHoldover } from './holdovers.js';
import { createHoliday, recordHolidayWork } from './holidays.js';
import { setLeaveBalance } from './leave-balances.js';
import { createLeaveBidRound, submitLeaveBid } from './leave-bidding.js';
import { importHistoricalLedger } from './ledger.js';
import { NURSE_SCOPED, type NurseScoped } from './nurse-record.completeness.test-support.js';
import { nurseRecord } from './nurse-record.js';
import { createNurseUnit } from './nurse-units.js';
import { createOvertimeVolunteer } from './overtime-volunteers.js';
import { createPayRate } from './pay.js';
import { createPreceptorship } from './preceptorships.js';
import { publishSchedule, recordScheduleChange } from './publish.js';
import { createRestWaiver } from './rest-waivers.js';
import {
  createNurse,
  deactivateNurse,
  grantCredential,
  replaceNursePreferences,
} from './roster.js';
import { createCredential } from './roster-io.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod, getAssignment } from './schedule.js';
import { createTimeOffRequest } from './timeoff.js';

const ACTOR = 'manager';
const d = isoDate;

interface Ctx {
  db: OpenedDatabase['db'];
  unitId: Id;
  eastId: Id;
  dayId: Id;
  draftId: Id;
  publishedId: Id;
  credentialId: Id;
  ana: Nurse;
  bea: Nurse;
  /** A shift Ana holds on the published period, and one Bea holds. */
  anasShift: Id;
  beasShift: Id;
}

let handle: OpenedDatabase;
let ctx: Ctx;

const mkNurse = (unitId: Id, firstName: string): Nurse =>
  createNurse(
    handle.db,
    {
      unitId,
      employeeId: nextEmployeeId(),
      firstName,
      lastName: 'Test',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: d('2020-01-01'),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  );

beforeEach(() => {
  handle = openTestDatabase();
  const db = handle.db;
  const mkUnit = (name: string) =>
    createUnit(
      db,
      { name, unitType: 'Medical-Surgical', payPeriodDays: 14, payPeriodAnchor: d('2026-01-04') },
      ACTOR,
    ).id;
  const unitId = mkUnit('4 West');
  const eastId = mkUnit('5 East');
  const dayId = createShiftType(
    db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#f59e0b',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  const rules = transact(db, (tx) =>
    saveRuleSet(
      tx,
      {
        unitId,
        name: 'Default',
        weekendDefinition: {
          startWeekday: 6,
          startMinute: 0,
          durationMinutes: 2880,
          mode: 'starts_within',
        },
        fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
        configs: [],
      },
      ACTOR,
    ),
  );
  const mkPeriod = (name: string, startDate: string, endDate: string) =>
    createPeriod(
      db,
      {
        unitId,
        name,
        startDate: d(startDate),
        endDate: d(endDate),
        ruleSetId: rules.id,
        ruleSetVersion: rules.version,
      },
      ACTOR,
    ).id;
  const draftId = mkPeriod('Jan A', '2026-01-15', '2026-01-28');
  const publishedId = mkPeriod('Mar A', '2026-03-01', '2026-03-14');
  const credentialId = createCredential(
    db,
    { code: 'ACLS', name: 'Advanced cardiac life support', tracksExpiry: true },
    ACTOR,
  ).id;
  const ana = mkNurse(unitId, 'Ana');
  const bea = mkNurse(unitId, 'Bea');
  const shiftFor = (nurseId: Id, date: string) =>
    createAssignment(
      db,
      { periodId: publishedId, nurseId, shiftTypeId: dayId, date: d(date) },
      ACTOR,
    ).id;
  const anasShift = shiftFor(ana.id, '2026-03-02');
  const beasShift = shiftFor(bea.id, '2026-03-03');
  transact(db, (tx) => publishSchedule(tx, { periodId: publishedId, ledger: [] }, ACTOR));
  ctx = {
    db,
    unitId,
    eastId,
    dayId,
    draftId,
    publishedId,
    credentialId,
    ana,
    bea,
    anasShift,
    beasShift,
  };
});
afterEach(() => handle.close());

const NO_IMPACT: ResolutionImpact = {
  coverage: { hardShortfallBefore: 1, hardShortfallAfter: 0, delta: -1 },
  fairness: { unitScoreBefore: 80, unitScoreAfter: 80, delta: 0, affected: [] },
  cost: {
    dollarsBefore: 1000,
    dollarsAfter: 1450,
    delta: 450,
    unpriced: false,
    overtimeHoursDelta: 0,
    pessimisticDelta: 450,
  },
  softViolationsIntroduced: [],
  softViolationsCleared: [],
  shortfallPriceDelta: -1,
  targetShortfallDelta: -1,
};

interface Case {
  /** One real repository write about Ana (and Bea, where a second party is needed). */
  act: (c: Ctx) => void;
  /** Everyone the entry is about, so each must find it in her record. Defaults to Ana. */
  about?: (c: Ctx) => Nurse[];
}

const CASES: Record<NurseScoped, Case> = {
  // H-10: a holdover is audited on the assignment; the snapshot must still name her.
  assignment: {
    act: (c) =>
      recordHoldover(
        c.db,
        { assignmentId: c.anasShift, minutes: 90, mandated: true, reason: 'Relief never arrived' },
        ACTOR,
      ),
  },
  call_attempt: {
    act: (c) => {
      const off = reportCallOff(c.db, c.beasShift, ACTOR, 'Sick');
      logCallAttempt(c.db, off.id, c.ana.id, 'accepted', ACTOR);
    },
  },
  call_off: { act: (c) => reportCallOff(c.db, c.anasShift, ACTOR, 'Sick') },
  conflict: {
    act: (c) => {
      const resolution: Resolution = {
        id: 'res_assign_available',
        conflictId: 'conf_sat_night',
        kind: 'assign_available',
        title: 'Assign Ana',
        description: 'Assign Ana to the day shift that is one RN short.',
        actions: [
          {
            type: 'create_assignment',
            nurseId: c.ana.id,
            shiftTypeId: c.dayId,
            date: d('2026-01-17'),
            isCharge: false,
            isOvertime: false,
          },
        ],
        impact: NO_IMPACT,
        score: 10,
        nurseIds: [c.ana.id],
      };
      transact(c.db, (tx) =>
        applyResolution(tx, c.draftId, resolution, ACTOR, {
          auto: false,
          reason: 'Ana volunteered',
        }),
      );
    },
  },
  day_of_pay_event: {
    act: (c) =>
      createDayOfPayEvent(
        c.db,
        {
          unitId: c.unitId,
          nurseId: c.ana.id,
          kind: 'missed_break',
          date: d('2026-03-02'),
          break: 'meal',
        },
        ACTOR,
      ),
  },
  // M-47: a re-import audits the rows it replaced and wrote.
  fairness_ledger: {
    act: (c) =>
      transact(c.db, (tx) =>
        importHistoricalLedger(
          tx,
          c.unitId,
          [
            {
              nurseId: c.ana.id,
              periodId: c.draftId,
              periodStart: d('2026-01-15'),
              periodDays: 14,
              nightShifts: 3,
            },
          ],
          ACTOR,
        ),
      ),
  },
  float_record: {
    act: (c) =>
      createFloatRecord(
        c.db,
        {
          unitId: c.unitId,
          nurseId: c.ana.id,
          date: d('2026-03-02'),
          shiftTypeId: c.dayId,
          toUnit: '5 East',
          volunteered: false,
          objection: 'Not orientated to telemetry',
        },
        ACTOR,
      ),
  },
  // M-39 / M-46: who worked a past holiday, recorded by hand.
  holiday_work: {
    act: (c) => {
      const xmas = createHoliday(
        c.db,
        {
          unitId: c.unitId,
          date: d('2025-12-25'),
          name: 'Christmas Day',
          isMajor: true,
          pairedHolidayId: null,
        },
        ACTOR,
      );
      transact(c.db, (tx) => recordHolidayWork(tx, xmas.id, [c.ana.id], ACTOR));
    },
  },
  leave_balance: {
    act: (c) =>
      setLeaveBalance(
        c.db,
        { nurseId: c.ana.id, type: 'pto', balanceHours: 40, asOf: d('2026-03-01') },
        ACTOR,
      ),
  },
  leave_bid: {
    act: (c) => {
      const round = createLeaveBidRound(
        c.db,
        {
          unitId: c.unitId,
          name: 'Summer 2026',
          coversStart: d('2026-06-01'),
          coversEnd: d('2026-08-31'),
          opensOn: d('2026-03-01'),
          closesOn: d('2026-03-31'),
          offPerDay: { RN: 1 },
        },
        ACTOR,
      );
      submitLeaveBid(
        c.db,
        round.id,
        c.ana.id,
        [{ rank: 1, startDate: d('2026-07-06'), endDate: d('2026-07-12') }],
        ACTOR,
        d('2026-03-15'),
      );
    },
  },
  // L-69: deactivating a nurse is an update to her row, not a delete.
  nurse: { act: (c) => deactivateNurse(c.db, c.ana.id, ACTOR) },
  nurse_credential: {
    act: (c) =>
      grantCredential(
        c.db,
        { nurseId: c.ana.id, credentialId: c.credentialId, expiresOn: d('2027-01-01') },
        ACTOR,
      ),
  },
  nurse_unit: {
    act: (c) => createNurseUnit(c.db, { nurseId: c.ana.id, unitId: c.eastId }, ACTOR),
  },
  overtime_volunteer: {
    act: (c) =>
      createOvertimeVolunteer(
        c.db,
        {
          unitId: c.unitId,
          nurseId: c.ana.id,
          startDate: d('2026-03-02'),
          endDate: d('2026-03-08'),
        },
        ACTOR,
      ),
  },
  pay_rate: {
    act: (c) =>
      createPayRate(
        c.db,
        { nurseId: c.ana.id, role: null, hourlyRate: 52, effectiveFrom: d('2026-01-01') },
        ACTOR,
      ),
  },
  // M-46: an orientation names the orientee and the preceptor, never `nurseId`.
  preceptorship: {
    act: (c) =>
      createPreceptorship(
        c.db,
        {
          unitId: c.unitId,
          orienteeId: c.bea.id,
          preceptorId: c.ana.id,
          startDate: d('2026-03-01'),
          endDate: d('2026-03-28'),
        },
        ACTOR,
      ),
    about: (c) => [c.ana, c.bea],
  },
  preference: {
    act: (c) =>
      transact(c.db, (tx) =>
        replaceNursePreferences(
          tx,
          c.ana.id,
          [
            {
              id: 'pref-1',
              nurseId: c.ana.id,
              kind: 'prefer_shift_type',
              shiftTypeId: c.dayId,
              weight: 2,
            },
          ],
          ACTOR,
        ),
      ),
  },
  comp_time_credit: {
    act: (c) =>
      transact(c.db, (tx) =>
        recordCompTimeCredits(
          tx,
          c.publishedId,
          [{ nurseId: c.ana.id, overtimeHours: 4, creditedHours: 6, paidOvertimeHours: 0 }],
          ACTOR,
        ),
      ),
  },
  comp_time_election: {
    act: (c) =>
      createCompTimeElection(
        c.db,
        { unitId: c.unitId, nurseId: c.ana.id, startsOn: d('2026-03-02') },
        ACTOR,
      ),
  },
  rest_waiver: {
    act: (c) =>
      createRestWaiver(
        c.db,
        {
          unitId: c.unitId,
          nurseId: c.ana.id,
          date: d('2026-03-02'),
          reason: 'Asked to turn around',
        },
        ACTOR,
      ),
  },
  schedule_change: {
    act: (c) => {
      const before = getAssignment(c.db, c.anasShift);
      recordScheduleChange(
        c.db,
        {
          periodId: c.publishedId,
          kind: 'removed',
          assignmentId: c.anasShift,
          nurseId: c.ana.id,
          date: d('2026-03-02'),
          shiftTypeId: c.dayId,
          ...(before ? { before } : {}),
          reason: 'Unit closed for the day',
        },
        ACTOR,
      );
    },
  },
  shift_cancellation: {
    act: (c) =>
      recordShiftCancellation(
        c.db,
        {
          periodId: c.publishedId,
          nurseId: c.ana.id,
          shiftTypeId: c.dayId,
          date: d('2026-03-02'),
          reason: 'Low census',
        },
        ACTOR,
      ),
  },
  shift_swap: {
    act: (c) =>
      proposeSwap(
        c.db,
        {
          periodId: c.publishedId,
          kind: 'giveaway',
          requestingNurseId: c.bea.id,
          counterpartyNurseId: c.ana.id,
          offeredAssignmentId: c.beasShift,
        },
        ACTOR,
      ),
    about: (c) => [c.ana, c.bea],
  },
  time_off_request: {
    act: (c) =>
      createTimeOffRequest(
        c.db,
        { nurseId: c.ana.id, startDate: d('2026-03-20'), endDate: d('2026-03-22'), type: 'pto' },
        ACTOR,
      ),
  },
};

describe('what reaches a nurse’s record, written by the real repositories', () => {
  it('has a case for every kind of entry that is about a nurse', () => {
    expect(Object.keys(CASES).sort()).toEqual([...NURSE_SCOPED].sort());
  });

  describe.each(NURSE_SCOPED)('%s', (type) => {
    it('lands in the record of every nurse it is about, and not in a bystander’s', () => {
      const cy = mkNurse(ctx.unitId, 'Cy');
      const now = today();
      const count = (n: Nurse) =>
        nurseRecord(ctx.db, n.id, now, now).audit.filter((e) => e.entityType === type).length;
      const { act, about } = CASES[type];
      const parties = about ? about(ctx) : [ctx.ana];
      const before = parties.map(count);
      const cyBefore = count(cy);
      act(ctx);
      parties.forEach((n, i) => {
        expect(count(n), `${n.firstName}'s ${type} entries`).toBeGreaterThan(before[i]!);
      });
      expect(count(cy), `Cy's ${type} entries`).toBe(cyBefore);
    });
  });
});
