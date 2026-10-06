/**
 * Repository tests for the roster and unit configuration.
 *
 * These exercise behaviour that is easy to get quietly wrong and expensive to discover late:
 * patch semantics, soft-deactivation, seniority ordering, and the immutability of rule set
 * versions.
 */

import {
  DEFAULT_FAIRNESS_WEIGHTS,
  isoDate,
  type LeavePolicy,
  type Nurse,
  type Preference,
  type Unit,
} from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor, recentAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import * as s from '../schema.js';
import {
  createAcuityTier,
  createRatioRule,
  listActiveRatioRulesForUnit,
  listAcuityTiersForUnit,
} from './acuity.js';
import {
  createShiftType,
  createUnit,
  getShiftType,
  getUnit,
  listShiftTypesForUnit,
  updateShiftType,
  updateUnit,
} from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import {
  createNurse,
  credentialsExpiringBetween,
  deactivateNurse,
  getNurse,
  grantCredential,
  insertNurses,
  lapsedCredentialsForUnit,
  listActiveNursesForUnit,
  listNurseCredentials,
  listNursesForUnit,
  listPreferencesForNurse,
  listPreferencesForUnit,
  nursesBySeniority,
  replaceNursePreferences,
  updateCredentialExpiry,
  updateNurse,
} from './roster.js';
import { getLatestRuleSet, getRuleSet, saveRuleSet } from './rulesets.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;

function baseNurse(overrides: Partial<Omit<Nurse, 'id'>> = {}): Omit<Nurse, 'id'> {
  return {
    unitId,
    employeeId: nextEmployeeId(),
    firstName: 'Test',
    lastName: 'Nurse',
    role: 'RN',
    employmentType: 'full_time',
    fte: 1,
    contractedHoursPerPeriod: 72,
    seniorityDate: isoDate('2020-01-01'),
    isChargeEligible: false,
    isNovice: false,
    isFloatEligible: true,
    active: true,
    ...overrides,
  };
}

beforeEach(() => {
  handle = openTestDatabase();
  const unit = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
  unitId = unit.id;
});

afterEach(() => handle.close());

describe('nurses', () => {
  it('creates a nurse and records an audit entry', () => {
    const nurse = createNurse(handle.db, baseNurse({ firstName: 'Ada' }), ACTOR);
    expect(getNurse(handle.db, nurse.id)?.firstName).toBe('Ada');

    const history = auditHistoryFor(handle.db, 'nurse', nurse.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.action).toBe('create');
    expect(history[0]?.actor).toBe(ACTOR);
  });

  it('bulk-inserts a roster and marks each row as an import', () => {
    const created = insertNurses(
      handle.db,
      [baseNurse({ firstName: 'A' }), baseNurse({ firstName: 'B' }), baseNurse({ firstName: 'C' })],
      ACTOR,
    );
    expect(created).toHaveLength(3);
    expect(listNursesForUnit(handle.db, unitId)).toHaveLength(3);

    const imports = recentAudit(handle.db).filter((e) => e.action === 'import');
    expect(imports).toHaveLength(3);
  });

  it('treats an omitted patch key as "leave untouched"', () => {
    const nurse = createNurse(handle.db, baseNurse({ firstName: 'Ada', fte: 1 }), ACTOR);
    const updated = updateNurse(handle.db, nurse.id, { fte: 0.8 }, ACTOR);
    expect(updated.fte).toBe(0.8);
    expect(updated.firstName).toBe('Ada');
  });

  it('treats an explicit null in a patch as "clear this field"', () => {
    const nurse = createNurse(handle.db, baseNurse({ phone: '555-0100' }), ACTOR);
    expect(getNurse(handle.db, nurse.id)?.phone).toBe('555-0100');
    const cleared = updateNurse(handle.db, nurse.id, { phone: null }, ACTOR);
    expect(cleared.phone).toBeUndefined();
  });

  it('keeps a hire date apart from seniority, and clears it with null', () => {
    const nurse = createNurse(
      handle.db,
      baseNurse({ seniorityDate: isoDate('2012-05-01'), hireDate: isoDate('2015-09-14') }),
      ACTOR,
    );
    expect(getNurse(handle.db, nurse.id)).toMatchObject({
      seniorityDate: '2012-05-01',
      hireDate: '2015-09-14',
    });

    const moved = updateNurse(handle.db, nurse.id, { hireDate: isoDate('2016-01-04') }, ACTOR);
    expect(moved.hireDate).toBe('2016-01-04');
    const cleared = updateNurse(handle.db, nurse.id, { hireDate: null }, ACTOR);
    expect(cleared.hireDate).toBeUndefined();
    expect(getNurse(handle.db, nurse.id)).not.toHaveProperty('hireDate', expect.anything());

    const history = auditHistoryFor(handle.db, 'nurse', nurse.id);
    expect(history).toHaveLength(3);
    // Newest first: the clear is [0], the move [1].
    expect(history[1]).toMatchObject({
      before: { hireDate: '2015-09-14' },
      after: { hireDate: '2016-01-04' },
    });
  });

  it('keeps a nurse on a permanent night tour, and returns them to the rotation with null', () => {
    const nurse = createNurse(handle.db, baseNurse({ permanentTour: 'night' }), ACTOR);
    expect(getNurse(handle.db, nurse.id)?.permanentTour).toBe('night');

    const moved = updateNurse(handle.db, nurse.id, { permanentTour: 'evening' }, ACTOR);
    expect(moved.permanentTour).toBe('evening');
    const cleared = updateNurse(handle.db, nurse.id, { permanentTour: null }, ACTOR);
    expect(cleared.permanentTour).toBeUndefined();
    expect(getNurse(handle.db, nurse.id)).not.toHaveProperty('permanentTour', expect.anything());
  });

  it('keeps a three-twelve nurse’s scheduled days, and clears them with null', () => {
    const nurse = createNurse(handle.db, baseNurse({ scheduledDaysPerWeek: 3 }), ACTOR);
    expect(getNurse(handle.db, nurse.id)?.scheduledDaysPerWeek).toBe(3);

    const cleared = updateNurse(handle.db, nurse.id, { scheduledDaysPerWeek: null }, ACTOR);
    expect(cleared.scheduledDaysPerWeek).toBeUndefined();
    expect(getNurse(handle.db, nurse.id)?.scheduledDaysPerWeek).toBeUndefined();
  });

  it('refuses to move a nurse to another unit through an edit', () => {
    // Types stop this at compile time; nothing stops it in an IPC payload at runtime.
    const nurse = createNurse(handle.db, baseNurse({ firstName: 'Ada' }), ACTOR);
    const other = createUnit(
      handle.db,
      {
        name: '5 East',
        unitType: 'ICU',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const smuggled = { unitId: other.id, fte: 0.5 } as unknown as { fte: number };
    expect(() => updateNurse(handle.db, nurse.id, smuggled, ACTOR)).toThrow(/unitId/);
    expect(getNurse(handle.db, nurse.id)?.unitId).toBe(unitId);
    expect(getNurse(handle.db, nurse.id)?.fte).toBe(1);
  });

  it('keeps a deactivated nurse retrievable', () => {
    // Deleting would orphan historical assignments and make published schedules unreadable.
    const nurse = createNurse(handle.db, baseNurse(), ACTOR);
    deactivateNurse(handle.db, nurse.id, ACTOR);

    expect(getNurse(handle.db, nurse.id)?.active).toBe(false);
    expect(listNursesForUnit(handle.db, unitId)).toHaveLength(1);
    expect(listActiveNursesForUnit(handle.db, unitId)).toHaveLength(0);
  });

  it('orders by seniority with the longest-serving nurse first', () => {
    createNurse(
      handle.db,
      baseNurse({ firstName: 'Newest', seniorityDate: isoDate('2024-06-01') }),
      ACTOR,
    );
    createNurse(
      handle.db,
      baseNurse({ firstName: 'Oldest', seniorityDate: isoDate('2005-02-14') }),
      ACTOR,
    );
    createNurse(
      handle.db,
      baseNurse({ firstName: 'Middle', seniorityDate: isoDate('2015-09-30') }),
      ACTOR,
    );

    expect(nursesBySeniority(handle.db, unitId).map((n) => n.firstName)).toEqual([
      'Oldest',
      'Middle',
      'Newest',
    ]);
  });

  it('excludes inactive nurses from the seniority list', () => {
    const gone = createNurse(handle.db, baseNurse({ firstName: 'Gone' }), ACTOR);
    createNurse(handle.db, baseNurse({ firstName: 'Here' }), ACTOR);
    deactivateNurse(handle.db, gone.id, ACTOR);
    expect(nursesBySeniority(handle.db, unitId).map((n) => n.firstName)).toEqual(['Here']);
  });
});

describe('credentials', () => {
  function seedCredential(code: string): string {
    const id = `cred-${code}`;
    handle.db.insert(s.credential).values({ id, code, name: code, tracksExpiry: true }).run();
    return id;
  }

  it('finds credentials expiring inside a window', () => {
    const acls = seedCredential('ACLS');
    const nurse = createNurse(handle.db, baseNurse({ firstName: 'Expiring' }), ACTOR);
    grantCredential(
      handle.db,
      { nurseId: nurse.id, credentialId: acls, expiresOn: isoDate('2026-02-15') },
      ACTOR,
    );

    const found = credentialsExpiringBetween(
      handle.db,
      isoDate('2026-02-01'),
      isoDate('2026-02-28'),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.nurse.firstName).toBe('Expiring');
    expect(found[0]?.credential.code).toBe('ACLS');
  });

  it('excludes credentials expiring outside the window', () => {
    const acls = seedCredential('ACLS');
    const nurse = createNurse(handle.db, baseNurse(), ACTOR);
    grantCredential(
      handle.db,
      { nurseId: nurse.id, credentialId: acls, expiresOn: isoDate('2026-06-01') },
      ACTOR,
    );
    expect(
      credentialsExpiringBetween(handle.db, isoDate('2026-02-01'), isoDate('2026-02-28')),
    ).toHaveLength(0);
  });

  it('ignores credentials with no expiry', () => {
    const preceptor = seedCredential('PRECEPTOR');
    const nurse = createNurse(handle.db, baseNurse(), ACTOR);
    grantCredential(handle.db, { nurseId: nurse.id, credentialId: preceptor }, ACTOR);
    expect(
      credentialsExpiringBetween(handle.db, isoDate('2000-01-01'), isoDate('2099-01-01')),
    ).toHaveLength(0);
  });

  describe('credentials that have already lapsed', () => {
    const TODAY = isoDate('2026-10-04');

    function lapsed() {
      return lapsedCredentialsForUnit(handle.db, unitId, TODAY).map((e) => e.nurse.firstName);
    }

    it('lists a credential that expired yesterday', () => {
      const acls = seedCredential('ACLS');
      const nurse = createNurse(handle.db, baseNurse({ firstName: 'Lapsed' }), ACTOR);
      grantCredential(
        handle.db,
        { nurseId: nurse.id, credentialId: acls, expiresOn: isoDate('2026-10-03') },
        ACTOR,
      );
      expect(lapsed()).toEqual(['Lapsed']);
    });

    it('still counts a credential as valid on its expiry day', () => {
      const acls = seedCredential('ACLS');
      const nurse = createNurse(handle.db, baseNurse({ firstName: 'LastDay' }), ACTOR);
      grantCredential(
        handle.db,
        { nurseId: nurse.id, credentialId: acls, expiresOn: TODAY },
        ACTOR,
      );
      expect(lapsed()).toEqual([]);
    });

    it('clears the alert once the renewal date is recorded', () => {
      const acls = seedCredential('ACLS');
      const nurse = createNurse(handle.db, baseNurse({ firstName: 'Renewed' }), ACTOR);
      grantCredential(
        handle.db,
        { nurseId: nurse.id, credentialId: acls, expiresOn: isoDate('2026-09-01') },
        ACTOR,
      );
      expect(lapsed()).toEqual(['Renewed']);
      const record = listNurseCredentials(handle.db, nurse.id)[0]!;
      updateCredentialExpiry(handle.db, record.id, isoDate('2028-09-01'), ACTOR);
      expect(lapsed()).toEqual([]);
    });

    it('is not cleared by a valid record of a different credential', () => {
      const acls = seedCredential('ACLS');
      const bls = seedCredential('BLS');
      const nurse = createNurse(handle.db, baseNurse({ firstName: 'Mixed' }), ACTOR);
      grantCredential(
        handle.db,
        { nurseId: nurse.id, credentialId: acls, expiresOn: isoDate('2026-09-01') },
        ACTOR,
      );
      grantCredential(
        handle.db,
        { nurseId: nurse.id, credentialId: bls, expiresOn: isoDate('2028-09-01') },
        ACTOR,
      );
      expect(lapsed()).toEqual(['Mixed']);
    });

    it('ignores lapses older than a year and nurses who have left', () => {
      const acls = seedCredential('ACLS');
      const old = createNurse(handle.db, baseNurse({ firstName: 'Ancient' }), ACTOR);
      grantCredential(
        handle.db,
        { nurseId: old.id, credentialId: acls, expiresOn: isoDate('2025-09-01') },
        ACTOR,
      );
      const gone = createNurse(handle.db, baseNurse({ firstName: 'Gone' }), ACTOR);
      grantCredential(
        handle.db,
        { nurseId: gone.id, credentialId: acls, expiresOn: isoDate('2026-09-01') },
        ACTOR,
      );
      deactivateNurse(handle.db, gone.id, ACTOR);
      expect(lapsed()).toEqual([]);
    });
  });
});

describe('preferences', () => {
  it('replaces a nurse preferences wholesale and round-trips the union', () => {
    const nurse = createNurse(handle.db, baseNurse(), ACTOR);
    const shift = createShiftType(
      handle.db,
      {
        unitId,
        name: 'Night 12',
        abbreviation: 'N12',
        startTime: '19:00',
        durationHours: 12,
        isNight: true,
        isOnCall: false,
        color: '#4f46e5',
        sortOrder: 2,
        active: true,
      },
      ACTOR,
    );

    const prefs: Preference[] = [
      { id: 'p1', nurseId: nurse.id, kind: 'prefer_shift_type', shiftTypeId: shift.id, weight: 4 },
      { id: 'p2', nurseId: nurse.id, kind: 'weekend_appetite', level: -1, weight: 5 },
      { id: 'p3', nurseId: nurse.id, kind: 'preferred_block_length', shifts: 3, weight: 2 },
    ];
    replaceNursePreferences(handle.db, nurse.id, prefs, ACTOR);

    const back = listPreferencesForNurse(handle.db, nurse.id);
    expect(back).toHaveLength(3);
    expect(back).toEqual(expect.arrayContaining(prefs));
  });

  it('replacing with an empty list clears them', () => {
    const nurse = createNurse(handle.db, baseNurse(), ACTOR);
    replaceNursePreferences(
      handle.db,
      nurse.id,
      [{ id: 'p1', nurseId: nurse.id, kind: 'weekend_appetite', level: 1, weight: 3 }],
      ACTOR,
    );
    replaceNursePreferences(handle.db, nurse.id, [], ACTOR);
    expect(listPreferencesForNurse(handle.db, nurse.id)).toHaveLength(0);
  });

  it('loads every nurse preference for a unit in one call', () => {
    // Fairness scoring reads these for the whole team; an N+1 here would be felt.
    const a = createNurse(handle.db, baseNurse(), ACTOR);
    const b = createNurse(handle.db, baseNurse(), ACTOR);
    replaceNursePreferences(
      handle.db,
      a.id,
      [{ id: 'pa', nurseId: a.id, kind: 'weekend_appetite', level: -1, weight: 3 }],
      ACTOR,
    );
    replaceNursePreferences(
      handle.db,
      b.id,
      [{ id: 'pb', nurseId: b.id, kind: 'preferred_block_length', shifts: 4, weight: 1 }],
      ACTOR,
    );
    expect(listPreferencesForUnit(handle.db, unitId)).toHaveLength(2);
  });
});

describe('unit configuration', () => {
  const POLICY: LeavePolicy = {
    fmla: { regime: 'title5', yearMethod: 'rolling_forward' },
    leaveYearStart: 'first_full_pay_period',
    accrual: [
      {
        balanceType: 'annual',
        tiers: [
          { fromYearsOfService: 0, hoursPerPayPeriod: 4 },
          { fromYearsOfService: 3, hoursPerPayPeriod: 6 },
        ],
        carryoverCapHours: 240,
      },
    ],
  };

  it('stores a leave policy on the unit, audits it, and clears it with null', () => {
    expect(getUnit(handle.db, unitId)?.leavePolicy).toBeUndefined();
    updateUnit(handle.db, unitId, { leavePolicy: POLICY }, ACTOR);
    expect(getUnit(handle.db, unitId)?.leavePolicy).toEqual(POLICY);

    updateUnit(handle.db, unitId, { leavePolicy: null }, ACTOR);
    expect(getUnit(handle.db, unitId)?.leavePolicy).toBeUndefined();

    const history = auditHistoryFor(handle.db, 'unit', unitId);
    const updates = history.filter((h) => h.action === 'update');
    expect(updates).toHaveLength(2);
    const setIt = updates.find((u) => (u.after as Unit).leavePolicy !== undefined)!;
    expect((setIt.before as Unit).leavePolicy).toBeUndefined();
    const clearIt = updates.find((u) => (u.before as Unit).leavePolicy !== undefined)!;
    expect((clearIt.before as Unit).leavePolicy).toEqual(POLICY);
  });

  it('stores overtime order, per-diem commitment and the consent requirement, and clears them', () => {
    const unit = getUnit(handle.db, unitId)!;
    expect(unit.overtimeOrder).toBeUndefined();
    expect(unit.perDiemCommitment).toBeUndefined();
    expect(unit.requireConsentForPostedChanges).toBeUndefined();

    updateUnit(
      handle.db,
      unitId,
      {
        overtimeOrder: 'roster',
        perDiemCommitment: { weekendShiftsPer4Weeks: 2, holidayShiftsPerYear: 1 },
        requireConsentForPostedChanges: true,
      },
      ACTOR,
    );
    expect(getUnit(handle.db, unitId)).toMatchObject({
      overtimeOrder: 'roster',
      perDiemCommitment: { weekendShiftsPer4Weeks: 2, holidayShiftsPerYear: 1 },
      requireConsentForPostedChanges: true,
    });

    updateUnit(
      handle.db,
      unitId,
      { overtimeOrder: null, perDiemCommitment: null, requireConsentForPostedChanges: null },
      ACTOR,
    );
    const cleared = getUnit(handle.db, unitId)!;
    expect(cleared.overtimeOrder).toBeUndefined();
    expect(cleared.perDiemCommitment).toBeUndefined();
    expect(cleared.requireConsentForPostedChanges).toBeUndefined();
  });

  it('refuses a leave policy with an earning rate of zero, and stores nothing', () => {
    const bad: LeavePolicy = {
      ...POLICY,
      accrual: [
        { balanceType: 'annual', tiers: [{ fromYearsOfService: 0, hoursPerPayPeriod: 0 }] },
      ],
    };
    expect(() => updateUnit(handle.db, unitId, { leavePolicy: bad }, ACTOR)).toThrow(
      /greater than zero/,
    );
    expect(getUnit(handle.db, unitId)?.leavePolicy).toBeUndefined();
  });

  it('orders shift types by sortOrder', () => {
    const mk = (name: string, sortOrder: number) =>
      createShiftType(
        handle.db,
        {
          unitId,
          name,
          abbreviation: name,
          startTime: '07:00',
          durationHours: 12,
          isNight: false,
          isOnCall: false,
          color: '#000',
          sortOrder,
          active: true,
        },
        ACTOR,
      );
    mk('third', 3);
    mk('first', 1);
    mk('second', 2);
    expect(listShiftTypesForUnit(handle.db, unitId).map((t) => t.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('lets a shift run inside another only where its hours fit, and never in a chain', () => {
    const mk = (
      name: string,
      startTime: string,
      durationHours: number,
      withinShiftTypeId?: string,
    ) =>
      createShiftType(
        handle.db,
        {
          unitId,
          name,
          abbreviation: name,
          startTime,
          durationHours,
          isNight: false,
          isOnCall: false,
          color: '#000',
          sortOrder: 1,
          active: true,
          ...(withinShiftTypeId ? { withinShiftTypeId } : {}),
        },
        ACTOR,
      );
    const day = mk('D12', '07:00', 12);
    expect(day.withinShiftTypeId).toBeNull();
    const eight = mk('D8', '07:00', 8, day.id);
    expect(getShiftType(handle.db, eight.id)?.withinShiftTypeId).toBe(day.id);
    // 13:00–21:00 runs past the day 12's 19:00 end.
    expect(() => mk('M8', '13:00', 8, day.id)).toThrow(/does not fit inside/);
    // Cover comes from a standalone shift, not from one that is itself covered.
    expect(() => mk('M4', '09:00', 4, eight.id)).toThrow(/itself runs inside another/);
    // Moving the day 12 so the 8 no longer fits is refused too.
    expect(() => updateShiftType(handle.db, day.id, { startTime: '09:00' }, ACTOR)).toThrow(
      /D8 runs inside D12/,
    );
    updateShiftType(handle.db, eight.id, { withinShiftTypeId: null }, ACTOR);
    expect(getShiftType(handle.db, eight.id)?.withinShiftTypeId).toBeNull();
  });

  it('orders acuity tiers by level', () => {
    createAcuityTier(
      handle.db,
      { unitId, name: 'High', level: 3, careHoursPerPatientDay: 9 },
      ACTOR,
    );
    createAcuityTier(
      handle.db,
      { unitId, name: 'Routine', level: 1, careHoursPerPatientDay: 4 },
      ACTOR,
    );
    expect(listAcuityTiersForUnit(handle.db, unitId).map((t) => t.name)).toEqual([
      'Routine',
      'High',
    ]);
  });

  it('lists only active ratio rules', () => {
    createRatioRule(
      handle.db,
      { unitId, role: 'RN', acuityTierId: null, maxPatientsPerNurse: 5, active: true },
      ACTOR,
    );
    createRatioRule(
      handle.db,
      { unitId, role: 'RN', acuityTierId: null, maxPatientsPerNurse: 8, active: false },
      ACTOR,
    );
    const active = listActiveRatioRulesForUnit(handle.db, unitId);
    expect(active).toHaveLength(1);
    expect(active[0]?.maxPatientsPerNurse).toBe(5);
  });
});

describe('rule set versioning', () => {
  const weekend = {
    startWeekday: 6 as const,
    startMinute: 0,
    durationMinutes: 2880,
    mode: 'starts_within' as const,
  };

  function draft(name: string, minRestHours: number) {
    return {
      unitId,
      name,
      weekendDefinition: weekend,
      fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
      configs: [
        {
          ruleId: 'min-rest-between-shifts',
          enabled: true,
          params: { minRestHours, onCallCountsAsWork: false },
        },
      ],
    };
  }

  it('starts at version 1 and assembles its configs', () => {
    const saved = transact(handle.db, (tx) => saveRuleSet(tx, draft('Contract 2026', 10), ACTOR));
    expect(saved.version).toBe(1);

    const loaded = getLatestRuleSet(handle.db, unitId);
    expect(loaded?.configs).toHaveLength(1);
    expect(loaded?.configs[0]?.params).toMatchObject({ minRestHours: 10 });
    expect(loaded?.weekendDefinition).toMatchObject({ mode: 'starts_within' });
  });

  it('bumps the version on every save', () => {
    transact(handle.db, (tx) => saveRuleSet(tx, draft('v1', 10), ACTOR));
    const second = transact(handle.db, (tx) => saveRuleSet(tx, draft('v2', 12), ACTOR));
    expect(second.version).toBe(2);
    expect(getLatestRuleSet(handle.db, unitId)?.version).toBe(2);
  });

  it('never mutates an earlier version', () => {
    // This is the property that keeps a published schedule defensible: it was judged under
    // the rules in force at the time, and editing the rules later must not rewrite history.
    const v1 = transact(handle.db, (tx) => saveRuleSet(tx, draft('Original', 10), ACTOR));
    transact(handle.db, (tx) => saveRuleSet(tx, draft('Revised', 12), ACTOR));

    const reloaded = getRuleSet(handle.db, v1.id);
    expect(reloaded?.version).toBe(1);
    expect(reloaded?.name).toBe('Original');
    expect(reloaded?.configs[0]?.params).toMatchObject({ minRestHours: 10 });
  });

  it('keeps the fairness weights a rule set was saved with', () => {
    const heavyWeekends = { ...DEFAULT_FAIRNESS_WEIGHTS, weekends: 5 };
    const v1 = transact(handle.db, (tx) =>
      saveRuleSet(tx, { ...draft('Original', 10), fairnessWeights: heavyWeekends }, ACTOR),
    );
    // A later save with different weights must not alter the version already published under
    // the old ones — the same immutability the rules themselves get, and for the same reason.
    transact(handle.db, (tx) => saveRuleSet(tx, draft('Revised', 12), ACTOR));

    const reloaded = getRuleSet(handle.db, v1.id);
    expect(reloaded?.fairnessWeights).toEqual(heavyWeekends);
  });
});
