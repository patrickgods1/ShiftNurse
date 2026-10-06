import { beforeEach, describe, expect, it } from 'vitest';
import type { RestWaiver } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  EVENING_8,
  makeNurse,
  NIGHT_12,
  resetFixtureCounters,
  scenario,
  UNIT_ID,
} from '../testing/fixtures.js';
import { minRestRule, restWaivedOn } from './rest-rules.js';

beforeEach(() => resetFixtureCounters());

const ann = () => makeNurse({ id: 'ann', firstName: 'Ann', lastName: 'Lee' });
const bo = () => makeNurse({ id: 'bo', firstName: 'Bo', lastName: 'Ruiz' });

function waiver(nurseId: string, date: string): RestWaiver {
  return {
    id: `w-${nurseId}-${date}`,
    unitId: UNIT_ID,
    nurseId,
    date: isoDate(date),
    reason: 'Signed waiver, picking up the evening',
    createdAt: 0,
  };
}

/** Night 19:00 Mon 5 Jan to 07:00 Tue, then Evening 15:00 Tue 6 Jan: 8 hours' rest. */
function restFindings(restWaivers: RestWaiver[]) {
  const s = scenario({
    nurses: [ann(), bo()],
    assignments: [assign('ann', NIGHT_12, '2026-01-05'), assign('ann', EVENING_8, '2026-01-06')],
    restWaivers,
  });
  return minRestRule.evaluate(s.schedule, { minRestHours: 11, onCallCountsAsWork: false }, s.ctx);
}

describe('a nurse who waived rest in writing', () => {
  it('is flagged for an eight-hour turnaround against an eleven-hour minimum', () => {
    const found = restFindings([]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'insufficient_rest', details: { restHours: 8 } });
  });

  it('is not flagged for the shift that starts on the waived date', () => {
    expect(restFindings([waiver('ann', '2026-01-06')])).toHaveLength(0);
  });

  it('is still flagged when the waiver is dated for the earlier shift', () => {
    expect(restFindings([waiver('ann', '2026-01-05')])).toHaveLength(1);
  });

  it('is still flagged when the waiver belongs to a colleague', () => {
    expect(restFindings([waiver('bo', '2026-01-06')])).toHaveLength(1);
  });

  it('reads the waiver by nurse and date', () => {
    const s = scenario({ nurses: [ann()], restWaivers: [waiver('ann', '2026-01-06')] });
    expect(restWaivedOn(s.ctx, 'ann', isoDate('2026-01-06'))).toBe(true);
    expect(restWaivedOn(s.ctx, 'ann', isoDate('2026-01-07'))).toBe(false);
    expect(restWaivedOn(s.ctx, 'bo', isoDate('2026-01-06'))).toBe(false);
  });
});
