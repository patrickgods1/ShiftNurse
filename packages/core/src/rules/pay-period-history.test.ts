import { beforeEach, describe, expect, it } from 'vitest';
import type { Assignment, ShiftType, TimeOffRequest } from '../domain/entities.js';
import { type IsoDate, isoDate } from '../domain/time.js';
import { busyElsewhere } from '../schedule/elsewhere.js';
import {
  assign,
  DAY_12,
  makeNurse,
  resetFixtureCounters,
  scenario,
  testShiftTypes,
  testUnit,
  timeOff,
} from '../testing/fixtures.js';
import {
  type ContractedHoursParams,
  contractedHoursRule,
  judgedPayPeriods,
  payPeriodHoursFor,
} from './hours-rules.js';
import type { Violation } from './types.js';

beforeEach(() => {
  resetFixtureCounters();
});

// The fixture unit's 14-day pay periods are anchored on Sun 4 Jan 2026. A schedule of Sun 11 Jan –
// Sat 7 Feb opens in the middle of Jan 4–17, holds Jan 18–31 whole and ends inside Feb 1–14.
const START = isoDate('2026-01-11');
const END = isoDate('2026-02-07');
const WINDOW = { start: START, end: END };

const ana = () =>
  makeNurse({
    id: 'ana',
    firstName: 'Ana',
    lastName: 'Cruz',
    contractedHoursPerPeriod: 72,
    fte: 0.9,
  });

const prior = (dates: string[]): Assignment[] =>
  dates.map((date) => assign('ana', DAY_12, date, { periodId: 'prev' }));
const shifts = (dates: string[]): Assignment[] =>
  dates.map((date) => assign('ana', DAY_12, date, { id: `j${date.slice(8)}` }));

function evaluate(
  options: {
    historyFrom?: IsoDate;
    priorAssignments?: Assignment[];
    assignments?: Assignment[];
    shiftTypes?: ShiftType[];
    timeOff?: TimeOffRequest[];
  },
  params: Partial<ContractedHoursParams> = {},
) {
  const s = scenario({ startDate: START, endDate: END, nurses: [ana()], ...options });
  return contractedHoursRule.evaluate(
    s.schedule,
    { ...contractedHoursRule.defaultParams, ...params },
    s.ctx,
  );
}

const inPayPeriod = (found: Violation[], start: string) =>
  found.filter((v) => (v.details!.payPeriod as { start: string }).start === start);

describe('which pay periods a schedule judges', () => {
  it('judges the pay period it opens in whole once history covers its first day', () => {
    expect(judgedPayPeriods(WINDOW, testUnit, true, isoDate('2025-12-14'))).toEqual([
      { start: '2026-01-04', end: '2026-01-17', underJudged: true },
      { start: '2026-01-18', end: '2026-01-31', underJudged: true },
    ]);
  });

  it('judges only hours past the contract when history starts after the pay period does', () => {
    expect(judgedPayPeriods(WINDOW, testUnit, true, isoDate('2026-01-07'))).toEqual([
      { start: '2026-01-04', end: '2026-01-17', underJudged: false },
      { start: '2026-01-18', end: '2026-01-31', underJudged: true },
    ]);
  });

  it('keeps the old reading when the caller does not say how far history goes', () => {
    expect(judgedPayPeriods(WINDOW, testUnit, true, undefined)).toEqual([
      { start: '2026-01-18', end: '2026-01-31', underJudged: true },
    ]);
    expect(judgedPayPeriods(WINDOW, testUnit, false, undefined)).toEqual([
      { start: '2026-01-04', end: '2026-01-17', underJudged: true },
      { start: '2026-01-18', end: '2026-01-31', underJudged: true },
      { start: '2026-02-01', end: '2026-02-14', underJudged: true },
    ]);
  });
});

describe('a pay period the schedule opens in the middle of', () => {
  it("counts last schedule's shifts toward the pay period this one finishes", () => {
    // Prior D12 Jan 5, 6, 8 = 36h; in-period D12 Jan 12 = 12h → 48h, 72 − 48 = 24h short.
    const found = inPayPeriod(
      evaluate({
        historyFrom: isoDate('2025-12-14'),
        priorAssignments: prior(['2026-01-05', '2026-01-06', '2026-01-08']),
        assignments: shifts(['2026-01-12']),
      }),
      '2026-01-04',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'under_contracted_hours',
      amount: 24,
      assignmentIds: ['j12'],
      details: { scheduledHours: 48, priorHours: 36 },
    });
    expect(found[0]!.message).toContain(
      'Ana Cruz is scheduled 48h (36h of it before this schedule)',
    );
  });

  it('refuses hours past the contract in that pay period even when its start is not on record', () => {
    // Prior D12 Jan 7, 8, 9 = 36h; in-period D12 Jan 12, 13, 15, 16 = 48h → 84h, 84 − 72 = 12h
    // over, past the 4h tolerance.
    const found = inPayPeriod(
      evaluate({
        historyFrom: isoDate('2026-01-07'),
        priorAssignments: prior(['2026-01-07', '2026-01-08', '2026-01-09']),
        assignments: shifts(['2026-01-12', '2026-01-13', '2026-01-15', '2026-01-16']),
      }),
      '2026-01-04',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'over_contracted_hours',
      severity: 'hard',
      amount: 12,
      assignmentIds: ['j12', 'j13', 'j15', 'j16'],
    });
  });

  it('does not call a nurse short when the start of the pay period is not on record', () => {
    const found = evaluate({
      historyFrom: START,
      assignments: shifts(['2026-01-12']),
    });
    expect(inPayPeriod(found, '2026-01-04')).toEqual([]);
    // Jan 18–31 is wholly inside and holds nothing: 72h short.
    const whole = inPayPeriod(found, '2026-01-18');
    expect(whole).toHaveLength(1);
    expect(whole[0]).toMatchObject({ code: 'under_contracted_hours', amount: 72 });
  });

  it('says nothing over the contract that history alone made', () => {
    // Prior D12 Jan 4–10 = 84h, nothing in-period that pay period: nothing this schedule can fix.
    const found = evaluate({
      historyFrom: isoDate('2025-12-14'),
      priorAssignments: prior([
        '2026-01-04',
        '2026-01-05',
        '2026-01-06',
        '2026-01-07',
        '2026-01-08',
        '2026-01-09',
        '2026-01-10',
      ]),
    });
    expect(inPayPeriod(found, '2026-01-04')).toEqual([]);
  });

  it('judges as before when the caller does not say how far history goes', () => {
    // 48h prior + 36h in-period = 84h would be over, but without historyFrom it is not judged.
    const found = evaluate({
      priorAssignments: prior(['2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07']),
      assignments: shifts(['2026-01-12', '2026-01-13', '2026-01-14']),
    });
    expect(inPayPeriod(found, '2026-01-04')).toEqual([]);
  });

  it('leaves the pay period that runs past the schedule to the next one', () => {
    const found = evaluate({
      historyFrom: isoDate('2025-12-14'),
      assignments: shifts([
        '2026-02-01',
        '2026-02-02',
        '2026-02-03',
        '2026-02-04',
        '2026-02-05',
        '2026-02-06',
        '2026-02-07',
      ]),
    });
    expect(inPayPeriod(found, '2026-02-01')).toEqual([]);
  });

  it('judges the whole pay period from a schedule that ends inside it, when told to judge partial ones', () => {
    // D12 Feb 1–7 = 84h, 84 − 72 = 12h over.
    const found = evaluate(
      {
        assignments: shifts([
          '2026-02-01',
          '2026-02-02',
          '2026-02-03',
          '2026-02-04',
          '2026-02-05',
          '2026-02-06',
          '2026-02-07',
        ]),
      },
      { onlyCompletePayPeriods: false },
    );
    const trailing = inPayPeriod(found, '2026-02-01');
    expect(trailing).toHaveLength(1);
    expect(trailing[0]).toMatchObject({ code: 'over_contracted_hours', amount: 12 });
  });

  it('leaves a shift on another unit out of the contract and the finding', () => {
    // 5 West has Ana on Jan 9; this unit had her Jan 5, 6 (24h) and has her Jan 12 (12h): 36h
    // here, 72 − 36 = 36h short. The 5 West day is neither counted nor named.
    const WEST_DAY: ShiftType = { ...DAY_12, id: 'west-d12', unitId: 'unit-west' };
    const west = busyElsewhere(
      [assign('ana', WEST_DAY, '2026-01-09', { id: 'w09', periodId: 'west' })],
      [WEST_DAY],
      '5 West',
    );
    const s = scenario({
      startDate: START,
      endDate: END,
      nurses: [ana()],
      historyFrom: isoDate('2025-12-14'),
      priorAssignments: [...prior(['2026-01-05', '2026-01-06']), ...west.assignments],
      assignments: shifts(['2026-01-12']),
      shiftTypes: [...testShiftTypes, ...west.shiftTypes],
    });
    const hours = payPeriodHoursFor(
      s.schedule,
      'ana',
      { start: isoDate('2026-01-04'), end: isoDate('2026-01-17') },
      contractedHoursRule.defaultParams,
      s.ctx,
    );
    expect(hours).toEqual({
      scheduledHours: 36,
      priorHours: 24,
      paidLeaveHours: 0,
      assignmentIds: ['j12'],
    });
    // The rule reads the same 36h: 72 − 36 = 36h short (counting 5 West's day would make it 48h,
    // 24h short), and the finding names only this schedule's shift.
    const found = inPayPeriod(
      contractedHoursRule.evaluate(s.schedule, contractedHoursRule.defaultParams, s.ctx),
      '2026-01-04',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'under_contracted_hours',
      amount: 36,
      assignmentIds: ['j12'],
      details: { scheduledHours: 36, priorHours: 24 },
    });
  });

  it('does not let a day on another unit push a nurse over the contract here', () => {
    // This unit: prior D12 Jan 5, 6, 7, 8 (48h) + in-period Jan 12, 13 (24h) = 72h, exactly the
    // contract. 5 West has her Jan 9 and 10 (24h); counted, that would be 96h, 24h over.
    const WEST_DAY: ShiftType = { ...DAY_12, id: 'west-d12', unitId: 'unit-west' };
    const west = busyElsewhere(
      [
        assign('ana', WEST_DAY, '2026-01-09', { id: 'w09', periodId: 'west' }),
        assign('ana', WEST_DAY, '2026-01-10', { id: 'w10', periodId: 'west' }),
      ],
      [WEST_DAY],
      '5 West',
    );
    const found = evaluate({
      historyFrom: isoDate('2025-12-14'),
      priorAssignments: [
        ...prior(['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']),
        ...west.assignments,
      ],
      assignments: shifts(['2026-01-12', '2026-01-13']),
      shiftTypes: [...testShiftTypes, ...west.shiftTypes],
    });
    expect(inPayPeriod(found, '2026-01-04')).toEqual([]);
  });

  it('says nothing over the contract that history and paid leave alone made', () => {
    // Prior D12 Jan 5–9 = 60h, approved paid leave Jan 12–13 = 24h: 84h, 12h over the 72h
    // contract and past the 4h tolerance, but no shift of this schedule is in the pay period.
    const found = evaluate({
      historyFrom: isoDate('2025-12-14'),
      priorAssignments: prior([
        '2026-01-05',
        '2026-01-06',
        '2026-01-07',
        '2026-01-08',
        '2026-01-09',
      ]),
      timeOff: [timeOff('ana', '2026-01-12', '2026-01-13', { paidHours: 24 })],
    });
    expect(inPayPeriod(found, '2026-01-04')).toEqual([]);
  });

  it('judges the pay period it opens in from history when told to judge partial ones too', () => {
    // onlyCompletePayPeriods off, history from Dec 14: prior D12 Jan 5, 6, 8 (36h) + in-period
    // Jan 12 (12h) = 48h, 24h short. Counting only this schedule's shift would read 60h short.
    const found = inPayPeriod(
      evaluate(
        {
          historyFrom: isoDate('2025-12-14'),
          priorAssignments: prior(['2026-01-05', '2026-01-06', '2026-01-08']),
          assignments: shifts(['2026-01-12']),
        },
        { onlyCompletePayPeriods: false },
      ),
      '2026-01-04',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'under_contracted_hours',
      amount: 24,
      assignmentIds: ['j12'],
      details: { scheduledHours: 48, priorHours: 36 },
    });
  });

  it('still does not call a nurse short with partial pay periods on, when history is incomplete', () => {
    // onlyCompletePayPeriods off, history only from Jan 7: prior D12 Jan 7 (12h) + in-period
    // Jan 12 (12h) = 24h, 48h under the contract, but Jan 4–6 are not on record.
    const found = evaluate(
      {
        historyFrom: isoDate('2026-01-07'),
        priorAssignments: prior(['2026-01-07']),
        assignments: shifts(['2026-01-12']),
      },
      { onlyCompletePayPeriods: false },
    );
    expect(inPayPeriod(found, '2026-01-04')).toEqual([]);
  });
});
