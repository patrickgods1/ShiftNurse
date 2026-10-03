import { beforeEach, describe, expect, it } from 'vitest';
import {
  assign,
  DAY_12,
  makeNurse,
  resetFixtureCounters,
  scenario,
  timeOff,
} from '../testing/fixtures.js';
import { evaluateSchedule } from './registry.js';

beforeEach(() => {
  resetFixtureCounters();
});

const mei = () => makeNurse({ firstName: 'Mei', lastName: 'Haddad' });

function onPending(s: ReturnType<typeof scenario>) {
  return evaluateSchedule(s.schedule, s.ruleSet, s.ctx).violations.filter(
    (v) => v.code === 'works_during_pending_time_off',
  );
}

describe('days a nurse has asked off but nobody has decided yet', () => {
  it('warns when Mei is scheduled on a day of her pending wedding leave', () => {
    const nurse = mei();
    const shift = assign(nurse.id, DAY_12, '2026-01-06');
    const request = timeOff(nurse.id, '2026-01-05', '2026-01-07', {
      status: 'pending',
      reason: 'Wedding',
    });
    const found = onPending(
      scenario({ nurses: [nurse], assignments: [shift], timeOff: [request] }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: 'soft',
      nurseIds: [nurse.id],
      dates: ['2026-01-06'],
      assignmentIds: [shift.id],
    });
    expect(found[0]!.message).toBe(
      'Mei Haddad is scheduled for the Day 12 on Tue Jan 6, inside a PTO request still ' +
        'waiting for a decision (Mon Jan 5 – Wed Jan 7). Decide the request, or move the shift.',
    );
  });

  it('says nothing once the request is approved — the hard time-off rule takes over', () => {
    const nurse = mei();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-06')],
      timeOff: [timeOff(nurse.id, '2026-01-05', '2026-01-07', { status: 'approved' })],
    });
    expect(onPending(s)).toEqual([]);
  });

  it('says nothing about a denied or cancelled request', () => {
    const nurse = mei();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-06')],
      timeOff: [
        timeOff(nurse.id, '2026-01-05', '2026-01-07', { status: 'denied' }),
        timeOff(nurse.id, '2026-01-06', '2026-01-06', { status: 'cancelled' }),
      ],
    });
    expect(onPending(s)).toEqual([]);
  });

  it('leaves the day after the request alone', () => {
    const nurse = mei();
    const s = scenario({
      nurses: [nurse],
      assignments: [assign(nurse.id, DAY_12, '2026-01-08')],
      timeOff: [timeOff(nurse.id, '2026-01-05', '2026-01-07', { status: 'pending' })],
    });
    expect(onPending(s)).toEqual([]);
  });
});
