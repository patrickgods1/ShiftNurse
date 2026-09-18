/**
 * Repository tests for the roster and unit configuration.
 *
 * These exercise behaviour that is easy to get quietly wrong and expensive to discover late:
 * patch semantics, soft-deactivation, seniority ordering, and the immutability of rule set
 * versions.
 */

import { isoDate, type Nurse, type Preference } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor, recentAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import * as s from '../schema.js';
import {
  createAcuityTier,
  createRatioRule,
  createShiftType,
  createUnit,
  getLatestRuleSet,
  getRuleSet,
  listActiveRatioRulesForUnit,
  listAcuityTiersForUnit,
  listShiftTypesForUnit,
  saveRuleSet,
} from './config.js';
import {
  createNurse,
  credentialsExpiringBetween,
  deactivateNurse,
  getNurse,
  grantCredential,
  insertNurses,
  listActiveNursesForUnit,
  listNursesForUnit,
  listPreferencesForNurse,
  listPreferencesForUnit,
  nursesBySeniority,
  replaceNursePreferences,
  updateNurse,
} from './roster.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;

function baseNurse(overrides: Partial<Omit<Nurse, 'id'>> = {}): Omit<Nurse, 'id'> {
  return {
    unitId,
    employeeId: `E${Math.random().toString().slice(2, 8)}`,
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
    const saved = saveRuleSet(handle.db, draft('Contract 2026', 10), ACTOR);
    expect(saved.version).toBe(1);

    const loaded = getLatestRuleSet(handle.db, unitId);
    expect(loaded?.configs).toHaveLength(1);
    expect(loaded?.configs[0]?.params).toMatchObject({ minRestHours: 10 });
    expect(loaded?.weekendDefinition).toMatchObject({ mode: 'starts_within' });
  });

  it('bumps the version on every save', () => {
    saveRuleSet(handle.db, draft('v1', 10), ACTOR);
    const second = saveRuleSet(handle.db, draft('v2', 12), ACTOR);
    expect(second.version).toBe(2);
    expect(getLatestRuleSet(handle.db, unitId)?.version).toBe(2);
  });

  it('never mutates an earlier version', () => {
    // This is the property that keeps a published schedule defensible: it was judged under
    // the rules in force at the time, and editing the rules later must not rewrite history.
    const v1 = saveRuleSet(handle.db, draft('Original', 10), ACTOR);
    saveRuleSet(handle.db, draft('Revised', 12), ACTOR);

    const reloaded = getRuleSet(handle.db, v1.id);
    expect(reloaded?.version).toBe(1);
    expect(reloaded?.name).toBe('Original');
    expect(reloaded?.configs[0]?.params).toMatchObject({ minRestHours: 10 });
  });
});
