import { describe, expect, it } from 'vitest';
import { isoDate } from '../domain/time.js';
import { makeNurse, solveInputFrom, UNIT_ID } from '../testing/fixtures.js';
import { ruleContextForInput } from './rule-context.js';

const A = makeNurse({ id: 'nurse-a' });
const B = makeNurse({ id: 'nurse-b' });
const C = makeNurse({ id: 'nurse-c' });

// Friday 18:00 for 54 hours: not the default Saturday window, so a context that fell back to the
// default would show.
const FRIDAY_EVENING_WEEKEND = {
  startWeekday: 5,
  startMinute: 18 * 60,
  durationMinutes: 54 * 60,
  mode: 'overlaps',
} as const;

function periodInput() {
  const base = solveInputFrom({
    startDate: isoDate('2026-03-01'),
    endDate: isoDate('2026-03-14'),
    nurses: [A, B, C],
    restWaivers: [
      {
        id: 'waiver-1',
        unitId: UNIT_ID,
        nurseId: A.id,
        date: isoDate('2026-03-03'),
        reason: 'Asked to stay on for the evening after a night',
        createdAt: 0,
      },
    ],
    availabilityBlocks: [
      {
        id: 'block-1',
        unitId: UNIT_ID,
        nurseId: B.id,
        weekdays: [2],
        startTime: '06:00',
        endTime: '10:00',
        reason: 'School run',
      },
    ],
    overtimeVolunteers: [
      {
        id: 'offer-1',
        unitId: UNIT_ID,
        nurseId: C.id,
        startDate: isoDate('2026-03-01'),
        endDate: isoDate('2026-03-07'),
      },
    ],
    incompatibilityGroups: [
      {
        id: 'group-1',
        unitId: UNIT_ID,
        name: 'Not on together',
        nurseIds: [A.id, B.id],
        maxTogether: 1,
        reason: 'Family members',
      },
    ],
  });
  return {
    ...base,
    ruleSet: { ...base.ruleSet, weekendDefinition: FRIDAY_EVENING_WEEKEND },
  };
}

describe('the rule context a period input describes', () => {
  it('carries every waiver, accommodation, overtime offer and pairing the period recorded', () => {
    const input = periodInput();
    const ctx = ruleContextForInput(input);
    expect([...(ctx.restWaiversByNurse.get(A.id) ?? [])]).toEqual(['2026-03-03']);
    expect(ctx.availabilityBlocksByNurse.get(B.id)).toHaveLength(1);
    expect(ctx.overtimeVolunteersByNurse.get(C.id)).toHaveLength(1);
    expect(ctx.incompatibilityGroups).toHaveLength(1);
    expect(ctx.weekendDefinition).toEqual(FRIDAY_EVENING_WEEKEND);
  });

  it('judges with the nurses and shift types the caller passes, when it passes them', () => {
    const ctx = ruleContextForInput(periodInput(), { nurses: [A] });
    expect(ctx.nurses).toEqual([A]);
  });
});
