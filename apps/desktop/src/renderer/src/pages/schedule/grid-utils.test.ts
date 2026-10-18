import type { Assignment, ShiftDemand, Violation } from '@shiftnurse/core';
import { isoDate } from '@shiftnurse/core';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
} from '@shiftnurse/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  gridNurses,
  headcountRows,
  keyedViolations,
  monthSpans,
  rowSlices,
  staffingSummary,
} from './grid-utils.js';

beforeEach(() => resetFixtureCounters());

const MON = isoDate('2026-10-05');
const TUE = isoDate('2026-10-06');

function demand(
  date: string,
  shiftTypeId: string,
  rn: number,
  cna = 0,
  licensed?: NonNullable<ShiftDemand['licensed']>,
): ShiftDemand {
  const role = (r: 'RN' | 'LPN' | 'CNA', minCount: number) => ({
    role: r,
    minCount,
    targetCount: minCount,
    coverageFloorMin: minCount,
    coverageFloorTarget: minCount,
    ratioDerived: 0,
    bindingConstraint: 'coverage_floor' as const,
  });
  return {
    date: isoDate(date),
    shiftTypeId,
    projectedCensus: 0,
    weightedCareHoursPerDay: 0,
    careHoursThisShift: 0,
    hppdRecommendedNurses: 0,
    careHoursRecommendedNurses: 0,
    byRole: { RN: role('RN', rn), LPN: role('LPN', 0), CNA: role('CNA', cna) },
    ...(licensed ? { licensed } : {}),
    fromCoverageFloorOnly: true,
  } as ShiftDemand;
}

// 20 patients under a licensed 1:5 rule with a 50% RN share: 4 licensed nurses, 2 of them RNs.
const POOLED = {
  ratioBedside: 4,
  chargeWithoutPatients: 0,
  breakRelief: 0,
  ratioDerived: 4,
  minRn: 2,
};

describe('the headcount under the grid', () => {
  it('counts Monday day RNs against what the floor needs, and shows Tuesday short', () => {
    const [a, b, c] = [makeNurse(), makeNurse(), makeNurse({ role: 'CNA' })];
    const assignments: Assignment[] = [
      assign(a!.id, DAY_12, '2026-10-05'),
      assign(b!.id, DAY_12, '2026-10-05'),
      assign(c!.id, DAY_12, '2026-10-05'),
      assign(a!.id, DAY_12, '2026-10-06'),
    ];
    const rows = headcountRows({
      shiftTypes: [DAY_12, NIGHT_12],
      nurses: [a!, b!, c!],
      assignments,
      demand: [demand('2026-10-05', DAY_12.id, 2, 1), demand('2026-10-06', DAY_12.id, 2, 1)],
      dates: [MON, TUE],
    });
    expect(rows.map((r) => `${r.shiftType.abbreviation} ${r.role}`)).toEqual(['D12 RN', 'D12 CNA']);
    expect(rows[0]!.cells).toEqual([
      { date: MON, staffed: 2, required: 2 },
      { date: TUE, staffed: 1, required: 2 },
    ]);
    expect(rows[1]!.cells).toEqual([
      { date: MON, staffed: 1, required: 1 },
      { date: TUE, staffed: 0, required: 1 },
    ]);
  });

  it('does not count a floated shift in the headcount', () => {
    const [a, b] = [makeNurse(), makeNurse()];
    const rows = headcountRows({
      shiftTypes: [DAY_12],
      nurses: [a!, b!],
      assignments: [
        assign(a!.id, DAY_12, '2026-10-05'),
        assign(b!.id, DAY_12, '2026-10-05', { isLocked: true, floatedTo: '5 East' }),
      ],
      demand: [demand('2026-10-05', DAY_12.id, 2)],
      dates: [MON],
    });
    expect(rows[0]!.cells).toEqual([{ date: MON, staffed: 1, required: 2 }]);
  });

  it('leaves out on-call and any shift and role nobody needs or works', () => {
    const a = makeNurse();
    const rows = headcountRows({
      shiftTypes: [DAY_12, NIGHT_12, ON_CALL],
      nurses: [a],
      assignments: [assign(a.id, ON_CALL, '2026-10-05'), assign(a.id, NIGHT_12, '2026-10-06')],
      demand: [],
      dates: [MON, TUE],
    });
    expect(rows.map((r) => `${r.shiftType.abbreviation} ${r.role}`)).toEqual(['N12 RN']);
    expect(rows[0]!.cells[1]).toEqual({ date: TUE, staffed: 1, required: 0 });
  });
});

describe('the one-line staffing summary under the grid', () => {
  it('reads Monday as fully staffed and Tuesday as two short, naming who is missing', () => {
    const [a, b, c] = [makeNurse(), makeNurse(), makeNurse({ role: 'CNA' })];
    const rows = headcountRows({
      shiftTypes: [DAY_12, NIGHT_12],
      nurses: [a!, b!, c!],
      assignments: [
        assign(a!.id, DAY_12, '2026-10-05'),
        assign(b!.id, DAY_12, '2026-10-05'),
        assign(c!.id, DAY_12, '2026-10-05'),
        assign(a!.id, DAY_12, '2026-10-06'),
      ],
      demand: [demand('2026-10-05', DAY_12.id, 2, 1), demand('2026-10-06', DAY_12.id, 2, 1)],
      dates: [MON, TUE],
    });
    expect(staffingSummary(rows, [MON, TUE])).toEqual([
      { date: MON, short: 0, details: [] },
      { date: TUE, short: 2, details: ['D12 RN 1/2', 'D12 CNA 0/1'] },
    ]);
  });

  it('does not let an extra RN hide a missing CNA', () => {
    const [a, b, c] = [makeNurse(), makeNurse(), makeNurse()];
    const rows = headcountRows({
      shiftTypes: [DAY_12],
      nurses: [a!, b!, c!],
      assignments: [
        assign(a!.id, DAY_12, '2026-10-05'),
        assign(b!.id, DAY_12, '2026-10-05'),
        assign(c!.id, DAY_12, '2026-10-05'),
      ],
      demand: [demand('2026-10-05', DAY_12.id, 2, 1)],
      dates: [MON],
    });
    expect(staffingSummary(rows, [MON])).toEqual([
      { date: MON, short: 1, details: ['D12 CNA 0/1'] },
    ]);
  });
});

describe('the month band over the date row', () => {
  it('spans a schedule that runs from late October into November as two months', () => {
    const dates = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map(
      isoDate,
    );
    expect(monthSpans(dates)).toEqual([
      { label: 'October 2026', start: 0, count: 3 },
      { label: 'November 2026', start: 3, count: 2 },
    ]);
  });

  it('crosses a year end as two months, each naming its year', () => {
    expect(monthSpans([isoDate('2026-12-31'), isoDate('2027-01-01')])).toEqual([
      { label: 'December 2026', start: 0, count: 1 },
      { label: 'January 2027', start: 1, count: 1 },
    ]);
  });

  it('is empty for no dates', () => {
    expect(monthSpans([])).toEqual([]);
  });
});

describe('the staffing row on a unit with a pooled RN and LPN ratio', () => {
  it('shows two short when twenty patients need four licensed nurses and only two RNs are on', () => {
    const [a, b] = [makeNurse(), makeNurse()];
    const rows = headcountRows({
      shiftTypes: [DAY_12],
      nurses: [a!, b!],
      assignments: [assign(a!.id, DAY_12, '2026-10-05'), assign(b!.id, DAY_12, '2026-10-05')],
      demand: [demand('2026-10-05', DAY_12.id, 2, 0, POOLED)],
      dates: [MON],
    });
    expect(rows.map((r) => `${r.shiftType.abbreviation} ${r.role}`)).toEqual([
      'D12 RN',
      'D12 licensed',
    ]);
    expect(rows[0]!.cells).toEqual([{ date: MON, staffed: 2, required: 2 }]);
    expect(rows[1]!.cells).toEqual([{ date: MON, staffed: 2, required: 4 }]);
    expect(staffingSummary(rows, [MON])).toEqual([
      { date: MON, short: 2, details: ['D12 RN+LPN 2/4'] },
    ]);
  });

  it('does not count the missing RN twice when one RN and one LPN are on', () => {
    const [a, b] = [makeNurse(), makeNurse({ role: 'LPN' })];
    const rows = headcountRows({
      shiftTypes: [DAY_12],
      nurses: [a!, b!],
      assignments: [assign(a!.id, DAY_12, '2026-10-05'), assign(b!.id, DAY_12, '2026-10-05')],
      demand: [demand('2026-10-05', DAY_12.id, 2, 0, POOLED)],
      dates: [MON],
    });
    expect(rows.find((r) => r.role === 'RN')!.cells).toEqual([
      { date: MON, staffed: 1, required: 2 },
    ]);
    expect(rows.find((r) => r.role === 'licensed')!.cells).toEqual([
      { date: MON, staffed: 2, required: 4 },
    ]);
    expect(staffingSummary(rows, [MON])).toEqual([
      { date: MON, short: 2, details: ['D12 RN 1/2', 'D12 RN+LPN 2/4'] },
    ]);
  });

  it('adds no licensed row on a unit without a pooled ratio', () => {
    const a = makeNurse();
    const rows = headcountRows({
      shiftTypes: [DAY_12],
      nurses: [a],
      assignments: [assign(a.id, DAY_12, '2026-10-05')],
      demand: [demand('2026-10-05', DAY_12.id, 1, 1)],
      dates: [MON],
    });
    expect(rows.map((r) => r.role)).toEqual(['RN', 'CNA']);
  });
});

describe('who has a row on the grid', () => {
  it('keeps a nurse who left while she still holds a shift, after the others by name', () => {
    const ana = makeNurse({ firstName: 'Ana', lastName: 'Adams' });
    const gail = makeNurse({ firstName: 'Gail', lastName: 'Baker', active: false });
    const hal = makeNurse({ firstName: 'Hal', lastName: 'Clark', active: false });
    const rows = gridNurses([hal, gail, ana], [assign(gail.id, DAY_12, '2026-10-05')]);
    expect(rows.map((n) => n.lastName)).toEqual(['Adams', 'Baker']);
  });
});

function breach(
  ruleId: string,
  code: Violation['code'],
  details: Record<string, unknown>,
): Violation {
  return {
    ruleId,
    ruleName: ruleId,
    severity: 'hard',
    code,
    message: 'x',
    nurseIds: [],
    dates: [MON],
    assignmentIds: [],
    amount: 1,
    details,
  };
}

describe('keyedViolations', () => {
  it('gives every violation in a list its own key, even two RN breaches on one shift', () => {
    const keyed = keyedViolations([
      breach('patient-ratio-compliance', 'ratio_breach', {
        role: 'RN',
        shiftTypeId: DAY_12.id,
        standard: 'ratio',
      }),
      breach('patient-ratio-compliance', 'ratio_breach', {
        role: 'RN',
        shiftTypeId: DAY_12.id,
        standard: 'rn_share',
      }),
      breach('coverage-minimums', 'understaffed', { role: 'CNA', shiftTypeId: DAY_12.id }),
    ]);
    const keys = keyed.map((k) => k.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]!.endsWith('#0')).toBe(true);
    expect(keys[1]!.endsWith('#1')).toBe(true);
  });

  it('keys three empty-shift shortfalls on one day apart', () => {
    const keyed = keyedViolations([
      breach('coverage-minimums', 'understaffed', { role: 'RN', shiftTypeId: DAY_12.id }),
      breach('coverage-minimums', 'understaffed', { role: 'CNA', shiftTypeId: DAY_12.id }),
      breach('coverage-minimums', 'understaffed', { role: 'RN', shiftTypeId: NIGHT_12.id }),
    ]);
    expect(new Set(keyed.map((k) => k.key)).size).toBe(3);
  });

  it('numbers three identical breaches #0, #1 and #2 in list order', () => {
    const same = () =>
      breach('patient-ratio-compliance', 'ratio_breach', { role: 'RN', shiftTypeId: DAY_12.id });
    const keys = keyedViolations([same(), same(), same()]).map((k) => k.key);
    expect(keys.map((k) => k.slice(-2))).toEqual(['#0', '#1', '#2']);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('row slices', () => {
  function setup() {
    const [n1, n2, n3] = [makeNurse(), makeNurse(), makeNurse()] as [
      ReturnType<typeof makeNurse>,
      ReturnType<typeof makeNurse>,
      ReturnType<typeof makeNurse>,
    ];
    const nurses = [n1, n2, n3];
    const shifts = nurses.map((n) => assign(n.id, DAY_12, '2026-10-05'));
    const violation = {
      ruleId: 'x',
      severity: 'hard',
      message: 'Too much',
      nurseIds: [n1.id],
      dates: [],
      assignmentIds: [shifts[0]!.id],
    } as unknown as Violation;
    const base = {
      nurses,
      violationsByAssignment: new Map([[shifts[0]!.id, [violation]]]),
      violationsByNurse: new Map<string, Violation[]>(),
      preferenceNotes: new Map<string, string>(),
    };
    return { nurses, shifts, violation, base };
  }

  it("hands an unchanged nurse the same slice after a refetch that added someone else's shift", () => {
    const { nurses, shifts, base } = setup();
    const previous = rowSlices({ ...base, assignments: shifts });
    const extra = assign(nurses[1]!.id, DAY_12, '2026-10-06');

    const next = rowSlices({ ...base, assignments: [...shifts, extra], previous });

    expect(next.get(nurses[0]!.id)).toBe(previous.get(nurses[0]!.id));
    expect(next.get(nurses[2]!.id)).toBe(previous.get(nurses[2]!.id));
    expect(next.get(nurses[1]!.id)).not.toBe(previous.get(nurses[1]!.id));
  });

  it('hands every nurse the same slice when a new check finds the same violations', () => {
    const { shifts, violation, base } = setup();
    const previous = rowSlices({ ...base, assignments: shifts });

    const next = rowSlices({
      ...base,
      assignments: shifts,
      violationsByAssignment: new Map([[shifts[0]!.id, [violation]]]),
      previous,
    });

    for (const [id, slice] of previous) expect(next.get(id)).toBe(slice);
  });

  it('gives a nurse a new slice when one of her violations changed', () => {
    const { nurses, shifts, violation, base } = setup();
    const previous = rowSlices({ ...base, assignments: shifts });

    const next = rowSlices({
      ...base,
      assignments: shifts,
      violationsByAssignment: new Map([[shifts[0]!.id, [{ ...violation }]]]),
      previous,
    });

    expect(next.get(nurses[0]!.id)).not.toBe(previous.get(nurses[0]!.id));
    expect(next.get(nurses[1]!.id)).toBe(previous.get(nurses[1]!.id));
  });

  it('gives a nurse a new slice when her nurse-level violations or a preference note changed', () => {
    const { nurses, shifts, violation, base } = setup();
    const previous = rowSlices({ ...base, assignments: shifts });

    const next = rowSlices({
      ...base,
      assignments: shifts,
      violationsByNurse: new Map([[nurses[1]!.id, [violation]]]),
      preferenceNotes: new Map([[shifts[2]!.id, 'Goes against her request']]),
      previous,
    });

    expect(next.get(nurses[0]!.id)).toBe(previous.get(nurses[0]!.id));
    expect(next.get(nurses[1]!.id)).not.toBe(previous.get(nurses[1]!.id));
    expect(next.get(nurses[2]!.id)).not.toBe(previous.get(nurses[2]!.id));
  });
});
