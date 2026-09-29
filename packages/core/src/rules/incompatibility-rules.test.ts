import { beforeEach, describe, expect, it } from 'vitest';

import type { IncompatibilityGroup, Nurse, ShiftType } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  DAY_12,
  MID_8,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  type ScenarioOptions,
  scenario,
  testShiftTypes,
  UNIT_ID,
} from '../testing/fixtures.js';
import { evaluateSchedule } from './registry.js';
import type { Violation } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

/** 11:00–23:00: overlaps the day 12 from 11:00 to 19:00 and the night 12 from 19:00 to 23:00. */
const LATE_12: ShiftType = {
  ...DAY_12,
  id: 'st-l12',
  name: 'Late 12',
  abbreviation: 'L12',
  startTime: '11:00',
  sortOrder: 8,
};

const WED = '2026-01-07';

function group(members: Nurse[], overrides: Partial<IncompatibilityGroup> = {}) {
  return {
    id: 'grp-1',
    unitId: UNIT_ID,
    name: 'Keep apart',
    nurseIds: members.map((n) => n.id),
    maxTogether: 1,
    reason: 'Open HR investigation #4471',
    ...overrides,
  } satisfies IncompatibilityGroup;
}

function found(options: ScenarioOptions): { together: Violation[]; unbuffered: Violation[] } {
  const s = scenario(options);
  const { violations } = evaluateSchedule(s.schedule, s.ruleSet, s.ctx);
  return {
    together: violations.filter((v) => v.code === 'incompatible_staff_together'),
    unbuffered: violations.filter((v) => v.code === 'incompatible_staff_unbuffered'),
  };
}

/** Two outside nurses on a shift, so the buffer rule stays quiet unless a test wants it. */
function outsiders(shiftType: ShiftType, date: string, count = 2) {
  const nurses = Array.from({ length: count }, () => makeNurse());
  return { nurses, assignments: nurses.map((n) => assign(n.id, shiftType, date)) };
}

describe('nurses who should not work together', () => {
  it('flags the eight hours a day 12 and an 11:00 late 12 share, and only those', () => {
    const [ana, ben] = [makeNurse(), makeNurse()];
    const cover = outsiders(DAY_12, WED);
    const { together } = found({
      shiftTypes: [...testShiftTypes, LATE_12],
      nurses: [ana, ben, ...cover.nurses],
      assignments: [
        assign(ana.id, DAY_12, WED),
        assign(ben.id, LATE_12, WED),
        ...cover.assignments,
      ],
      incompatibilityGroups: [group([ana, ben])],
    });
    expect(together).toHaveLength(1);
    expect(together[0]!.severity).toBe('soft');
    expect(together[0]!.message).toContain('from 11:00 to 19:00');
    expect(together[0]!.details).toMatchObject({ hours: 8, onTogether: 2, maxTogether: 1 });
    expect(together[0]!.nurseIds.sort()).toEqual([ana.id, ben.id].sort());
  });

  it('reports a whole shared day 12 once, even though other shift types start inside it', () => {
    // The 15:00 evening 8 and the 07:00 day 8 cut the day into stretches; the manager sees one.
    const [ana, ben] = [makeNurse(), makeNurse()];
    const cover = outsiders(DAY_12, WED);
    const { together } = found({
      nurses: [ana, ben, ...cover.nurses],
      assignments: [assign(ana.id, DAY_12, WED), assign(ben.id, DAY_12, WED), ...cover.assignments],
      incompatibilityGroups: [group([ana, ben])],
    });
    expect(together).toHaveLength(1);
    expect(together[0]!.details).toMatchObject({ hours: 12 });
  });

  it('does not treat Friday’s night and Saturday’s day as working together', () => {
    const [ana, ben] = [makeNurse(), makeNurse()];
    const { together, unbuffered } = found({
      nurses: [ana, ben],
      assignments: [assign(ana.id, NIGHT_12, '2026-01-09'), assign(ben.id, DAY_12, '2026-01-10')],
      incompatibilityGroups: [group([ana, ben])],
    });
    expect(together).toEqual([]);
    expect(unbuffered).toEqual([]);
  });

  it('counts a mid 8 inside the day 12 as on the floor with it', () => {
    const [ana, ben] = [makeNurse(), makeNurse()];
    const cover = outsiders(DAY_12, WED);
    const { together } = found({
      shiftTypes: [...testShiftTypes, MID_8],
      nurses: [ana, ben, ...cover.nurses],
      assignments: [assign(ana.id, DAY_12, WED), assign(ben.id, MID_8, WED), ...cover.assignments],
      incompatibilityGroups: [group([ana, ben])],
    });
    expect(together).toHaveLength(1);
    expect(together[0]!.details).toMatchObject({ hours: 8 });
  });

  it('lets two of a five-nurse clique work together when the cap is two, but not three', () => {
    const clique = Array.from({ length: 5 }, () => makeNurse());
    const cover = outsiders(DAY_12, WED);
    const groups = [group(clique, { maxTogether: 2 })];
    const two = found({
      nurses: [...clique, ...cover.nurses],
      assignments: [
        ...clique.slice(0, 2).map((n) => assign(n.id, DAY_12, WED)),
        ...cover.assignments,
      ],
      incompatibilityGroups: groups,
    });
    expect(two.together).toEqual([]);

    const three = found({
      nurses: [...clique, ...cover.nurses],
      assignments: [
        ...clique.slice(0, 3).map((n) => assign(n.id, DAY_12, WED)),
        ...cover.assignments,
      ],
      incompatibilityGroups: groups,
    });
    expect(three.together).toHaveLength(1);
    expect(three.together[0]!.details).toMatchObject({ onTogether: 3, maxTogether: 2, excess: 1 });
  });

  it('never quotes the reason in the violation', () => {
    const [ana, ben] = [makeNurse(), makeNurse()];
    const { together, unbuffered } = found({
      nurses: [ana, ben],
      assignments: [assign(ana.id, DAY_12, WED), assign(ben.id, DAY_12, WED)],
      incompatibilityGroups: [group([ana, ben])],
    });
    for (const v of [...together, ...unbuffered]) {
      expect(v.message).not.toContain('HR');
      expect(JSON.stringify(v.details)).not.toContain('HR');
    }
  });

  it('ignores a group on shifts dated before it starts or after it ends', () => {
    const [ana, ben] = [makeNurse(), makeNurse()];
    const assignments = [assign(ana.id, DAY_12, WED), assign(ben.id, DAY_12, WED)];
    const ended = found({
      nurses: [ana, ben],
      assignments,
      incompatibilityGroups: [group([ana, ben], { endsOn: isoDate('2026-01-06') })],
    });
    expect(ended.together).toEqual([]);
    const notYet = found({
      nurses: [ana, ben],
      assignments,
      incompatibilityGroups: [group([ana, ben], { startsOn: isoDate('2026-01-08') })],
    });
    expect(notYet.together).toEqual([]);
    const onTheDay = found({
      nurses: [ana, ben],
      assignments,
      incompatibilityGroups: [group([ana, ben], { startsOn: isoDate(WED), endsOn: isoDate(WED) })],
    });
    expect(onTheDay.together).toHaveLength(1);
  });
});

describe('outside staff on the floor when incompatible nurses overlap', () => {
  it('requires two nurses from outside the group while two members share a day 12', () => {
    const [ana, ben] = [makeNurse(), makeNurse()];
    const cover = outsiders(DAY_12, WED, 1);
    const { unbuffered } = found({
      nurses: [ana, ben, ...cover.nurses],
      assignments: [assign(ana.id, DAY_12, WED), assign(ben.id, DAY_12, WED), ...cover.assignments],
      incompatibilityGroups: [group([ana, ben])],
    });
    expect(unbuffered).toHaveLength(1);
    expect(unbuffered[0]!.severity).toBe('hard');
    expect(unbuffered[0]!.details).toMatchObject({
      outside: 1,
      required: 2,
      shortfall: 1,
      hours: 12,
    });
  });

  it('is satisfied by two outside nurses', () => {
    const [ana, ben] = [makeNurse(), makeNurse()];
    const cover = outsiders(DAY_12, WED, 2);
    const { unbuffered } = found({
      nurses: [ana, ben, ...cover.nurses],
      assignments: [assign(ana.id, DAY_12, WED), assign(ben.id, DAY_12, WED), ...cover.assignments],
      incompatibilityGroups: [group([ana, ben])],
    });
    expect(unbuffered).toEqual([]);
  });

  it('only asks for the buffer during the hours the members actually overlap', () => {
    // Ana 07–19, Ben 11–23; the one outside nurse works the night from 19:00. Only 11–19 is short.
    const [ana, ben, cy] = [makeNurse(), makeNurse(), makeNurse()];
    const { unbuffered } = found({
      shiftTypes: [...testShiftTypes, LATE_12],
      nurses: [ana, ben, cy],
      assignments: [
        assign(ana.id, DAY_12, WED),
        assign(ben.id, LATE_12, WED),
        assign(cy.id, NIGHT_12, WED),
      ],
      incompatibilityGroups: [group([ana, ben])],
    });
    expect(unbuffered).toHaveLength(1);
    expect(unbuffered[0]!.message).toContain('from 11:00 to 19:00');
    expect(unbuffered[0]!.details).toMatchObject({ outside: 0, shortfall: 2, hours: 8 });
  });

  it('asks nothing of a member working without the others', () => {
    const [ana, ben] = [makeNurse(), makeNurse()];
    const { unbuffered } = found({
      nurses: [ana, ben],
      assignments: [assign(ana.id, DAY_12, WED)],
      incompatibilityGroups: [group([ana, ben])],
    });
    expect(unbuffered).toEqual([]);
  });

  it('takes the number of outside staff from the rule set', () => {
    const [ana, ben] = [makeNurse(), makeNurse()];
    const cover = outsiders(DAY_12, WED, 2);
    const { unbuffered } = found({
      nurses: [ana, ben, ...cover.nurses],
      assignments: [assign(ana.id, DAY_12, WED), assign(ben.id, DAY_12, WED), ...cover.assignments],
      incompatibilityGroups: [group([ana, ben], { maxTogether: 1 })],
      ruleParams: { 'incompatible-staff-buffer': { minOutsideStaff: 3 } },
    });
    expect(unbuffered[0]!.details).toMatchObject({ outside: 2, required: 3, shortfall: 1 });
  });
});
