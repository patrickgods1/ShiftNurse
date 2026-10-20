/**
 * The float pool: which other units may schedule a nurse. A membership in the nurse's own unit
 * would be a second statement of the same fact, and one removed under a shift already written
 * would leave a grid holding a shift for someone it no longer lists, so both are refused in words;
 * every change is audited with its `before`.
 */

import { defaultRuleSet, isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import {
  busyElsewhereFor,
  createNurseUnit,
  deleteNurseUnit,
  listFloatNurses,
  listNurseUnitsForNurse,
  listNurseUnitsForUnit,
  nurseWorksOnUnit,
  requireWorksOnUnit,
  updateNurseUnit,
} from './nurse-units.js';
import { publishSchedule } from './publish.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createAssignment, createPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let home: string;
let west: string;
let nurse: Nurse;

function mkUnit(name: string) {
  return createUnit(
    handle.db,
    {
      name,
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
}

function mkNurse(unitId: string, firstName: string): Nurse {
  return createNurse(
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
      seniorityDate: isoDate('2020-01-01'),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  );
}

beforeEach(() => {
  handle = openTestDatabase();
  home = mkUnit('4 West').id;
  west = mkUnit('5 West').id;
  nurse = mkNurse(home, 'Ana');
});
afterEach(() => handle.close());

const add = (extra: { competency?: string; startDate?: string; endDate?: string } = {}) =>
  createNurseUnit(
    handle.db,
    {
      nurseId: nurse.id,
      unitId: west,
      ...(extra.competency ? { competency: extra.competency } : {}),
      ...(extra.startDate ? { startDate: isoDate(extra.startDate) } : {}),
      ...(extra.endDate ? { endDate: isoDate(extra.endDate) } : {}),
    },
    ACTOR,
  );

describe('floating a nurse to another unit', () => {
  it('records the unit, the competency note and the dates, and audits the entry', () => {
    const m = add({ competency: 'Telemetry', startDate: '2026-10-01', endDate: '2026-12-31' });
    expect(listNurseUnitsForNurse(handle.db, nurse.id)).toEqual([m]);
    expect(listNurseUnitsForUnit(handle.db, west)).toEqual([m]);
    expect(auditHistoryFor(handle.db, 'nurse_unit', m.id)[0]).toMatchObject({
      action: 'create',
      actor: 'manager',
    });
  });

  it('refuses the nurse’s own home unit, in words', () => {
    expect(() => createNurseUnit(handle.db, { nurseId: nurse.id, unitId: home }, ACTOR)).toThrow(
      "4 West is already Ana Test's home unit",
    );
  });

  it('refuses a second entry for the same unit and asks to edit the first', () => {
    add();
    expect(() => add()).toThrow('already works on 5 West; edit that entry instead');
  });

  it('refuses a range that ends before it starts', () => {
    expect(() => add({ startDate: '2026-11-01', endDate: '2026-10-01' })).toThrow(
      'ends before it starts',
    );
  });
});

describe('changing or ending a float assignment', () => {
  it('audits an edit with what it was before, and clears a field with null', () => {
    const m = add({ competency: 'Telemetry', endDate: '2026-12-31' });
    const after = updateNurseUnit(handle.db, m.id, { competency: null }, ACTOR);
    expect(after.competency).toBeUndefined();
    expect(after.endDate).toBe('2026-12-31');
    expect(auditHistoryFor(handle.db, 'nurse_unit', m.id)[0]).toMatchObject({
      action: 'update',
      before: { competency: 'Telemetry' },
    });
  });

  it('refuses a patch that tries to move the nurse to another unit', () => {
    const m = add();
    expect(() => updateNurseUnit(handle.db, m.id, { unitId: home } as never, ACTOR)).toThrow(
      "cannot change 'unitId'",
    );
  });

  it('removes the entry and audits the delete with its before', () => {
    const m = add();
    deleteNurseUnit(handle.db, m.id, ACTOR);
    expect(listNurseUnitsForNurse(handle.db, nurse.id)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'nurse_unit', m.id)[0]).toMatchObject({
      action: 'delete',
      before: { id: m.id },
    });
  });

  it('will not end the float assignment while the nurse still has shifts on that unit', () => {
    const m = add();
    const shift = createShiftType(
      handle.db,
      {
        unitId: west,
        name: 'Day 12',
        abbreviation: 'D12',
        startTime: '07:00',
        durationHours: 12,
        isNight: false,
        isOnCall: false,
        color: '#000',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    );
    const rules = transact(handle.db, (tx) => saveRuleSet(tx, defaultRuleSet(west), ACTOR));
    const period = createPeriod(
      handle.db,
      {
        unitId: west,
        name: 'P',
        startDate: isoDate('2026-10-04'),
        endDate: isoDate('2026-11-14'),
        ruleSetId: rules.id,
        ruleSetVersion: rules.version,
      },
      ACTOR,
    );
    createAssignment(
      handle.db,
      {
        periodId: period.id,
        nurseId: nurse.id,
        shiftTypeId: shift.id,
        date: isoDate('2026-10-10'),
      },
      ACTOR,
    );
    expect(() => deleteNurseUnit(handle.db, m.id, ACTOR)).toThrow(
      'Ana Test still has 1 shift on 5 West',
    );
    expect(() =>
      updateNurseUnit(handle.db, m.id, { startDate: isoDate('2026-10-20') }, ACTOR),
    ).toThrow('has 1 shift on 5 West outside those dates');
    expect(listNurseUnitsForUnit(handle.db, west)).toHaveLength(1);
  });
});

describe('who floats into a unit for a period', () => {
  it('lists members whose dates touch the window, in the order they were added', () => {
    const inside = mkNurse(home, 'Ivy');
    const outside = mkNurse(home, 'Olga');
    add({ startDate: '2026-10-01', endDate: '2026-10-31' });
    createNurseUnit(handle.db, { nurseId: inside.id, unitId: west }, ACTOR);
    createNurseUnit(
      handle.db,
      { nurseId: outside.id, unitId: west, endDate: isoDate('2026-01-31') },
      ACTOR,
    );
    expect(
      listFloatNurses(handle.db, west, isoDate('2026-10-04'), isoDate('2026-11-14')).map(
        (n) => n.firstName,
      ),
    ).toEqual(['Ana', 'Ivy']);
  });

  it('has no busy time elsewhere when nobody works on another unit', () => {
    expect(
      busyElsewhereFor(handle.db, home, [nurse.id], isoDate('2026-10-04'), isoDate('2026-11-14')),
    ).toEqual({ shiftTypes: [], assignments: [] });
  });

  it("shows a nurse's published shift on another unit as busy time here", () => {
    add();
    const shift = createShiftType(
      handle.db,
      {
        unitId: west,
        name: 'Day 12',
        abbreviation: 'D12',
        startTime: '07:00',
        durationHours: 12,
        isNight: false,
        isOnCall: false,
        color: '#000',
        sortOrder: 1,
        active: true,
      },
      ACTOR,
    );
    const rules = transact(handle.db, (tx) => saveRuleSet(tx, defaultRuleSet(west), ACTOR));
    const period = (name: string, startDate: string, endDate: string) =>
      createPeriod(
        handle.db,
        {
          unitId: west,
          name,
          startDate: isoDate(startDate),
          endDate: isoDate(endDate),
          ruleSetId: rules.id,
          ruleSetVersion: rules.version,
        },
        ACTOR,
      );
    const shiftOn = (periodId: string, date: string) =>
      createAssignment(
        handle.db,
        { periodId, nurseId: nurse.id, shiftTypeId: shift.id, date: isoDate(date) },
        ACTOR,
      );
    const published = period('Early', '2026-10-04', '2026-10-11');
    const tenth = shiftOn(published.id, '2026-10-10');
    transact(handle.db, (tx) => publishSchedule(tx, { periodId: published.id }, ACTOR));
    // A draft blocks the nurse here too: its manager is still planning her.
    const draft = period('Late', '2026-10-12', '2026-11-14');
    const twelfth = shiftOn(draft.id, '2026-10-12');

    const busy = busyElsewhereFor(
      handle.db,
      home,
      [nurse.id],
      isoDate('2026-10-04'),
      isoDate('2026-11-14'),
    );
    expect(busy.assignments.map((a) => [a.id, a.nurseId, a.date])).toEqual([
      [tenth.id, nurse.id, '2026-10-10'],
      [twelfth.id, nurse.id, '2026-10-12'],
    ]);
    for (const a of busy.assignments) {
      expect(a).toMatchObject({ isLocked: true, shiftTypeId: `elsewhere:${shift.id}` });
    }
    expect(busy.shiftTypes).toHaveLength(1);
    expect(busy.shiftTypes[0]).toMatchObject({
      id: `elsewhere:${shift.id}`,
      name: 'Day 12 on 5 West',
      active: false,
      elsewhere: true,
    });
  });
});

describe('who works on a unit', () => {
  let fran: Nurse;
  const day = (d: string) => ({ start: isoDate(d), end: isoDate(d) });
  beforeEach(() => {
    fran = mkNurse(west, 'Fran');
    createNurseUnit(
      handle.db,
      {
        nurseId: fran.id,
        unitId: home,
        startDate: isoDate('2026-03-01'),
        endDate: isoDate('2026-03-31'),
      },
      ACTOR,
    );
  });

  it('counts the home unit on any day', () => {
    expect(
      nurseWorksOnUnit(handle.db, nurse.id, home, {
        start: isoDate('1999-01-01'),
        end: isoDate('2099-12-31'),
      }),
    ).toBe(true);
  });

  it('counts a float only on the days her membership covers', () => {
    expect(nurseWorksOnUnit(handle.db, fran.id, home, day('2026-03-10'))).toBe(true);
    expect(nurseWorksOnUnit(handle.db, fran.id, home, day('2026-02-28'))).toBe(false);
    expect(
      nurseWorksOnUnit(handle.db, fran.id, home, {
        start: isoDate('2026-03-25'),
        end: isoDate('2026-04-02'),
      }),
    ).toBe(false);
  });

  it('counts an open-ended membership from its first day on', () => {
    const [m] = listNurseUnitsForNurse(handle.db, fran.id);
    updateNurseUnit(handle.db, m!.id, { endDate: null }, ACTOR);
    expect(nurseWorksOnUnit(handle.db, fran.id, home, day('2027-01-01'))).toBe(true);
    expect(nurseWorksOnUnit(handle.db, fran.id, home, day('2026-02-28'))).toBe(false);
  });

  it('refuses in words naming the nurse, the unit and the day', () => {
    expect(() => requireWorksOnUnit(handle.db, fran.id, home, day('2026-04-02'))).toThrow(
      "Fran Test is not on 4 West's roster on Thu Apr 2; add a float membership covering that day under Roster.",
    );
  });

  it('refuses a stretch in words naming the whole range', () => {
    expect(() =>
      requireWorksOnUnit(handle.db, fran.id, home, {
        start: isoDate('2026-03-25'),
        end: isoDate('2026-04-02'),
      }),
    ).toThrow("is not on 4 West's roster for every day of");
  });

  it('says so when the nurse or the unit is unknown', () => {
    expect(() => requireWorksOnUnit(handle.db, 'nope', home, day('2026-03-10'))).toThrow(
      'That nurse is not on the roster.',
    );
    expect(() => requireWorksOnUnit(handle.db, fran.id, 'nope', day('2026-03-10'))).toThrow(
      'That unit does not exist.',
    );
  });
});
