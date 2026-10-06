import { beforeEach, describe, expect, it } from 'vitest';
import type { AvailabilityBlock } from '../domain/entities.js';
import { dayNumber, type IsoDate, isoDate, MINUTES_PER_DAY } from '../domain/time.js';
import {
  assign,
  DAY_12,
  makeNurse,
  NIGHT_12,
  ON_CALL,
  resetFixtureCounters,
  scenario,
  UNIT_ID,
} from '../testing/fixtures.js';
import {
  accommodationBlocksRule,
  blockedAt,
  blockOccurrencesOverlapping,
} from './availability-blocks.js';

beforeEach(() => resetFixtureCounters());

const ann = () => makeNurse({ id: 'ann', firstName: 'Ann', lastName: 'Lee' });

const REASON = 'Observes the Sabbath (religious accommodation, HR file 4471)';

/** Sabbath: Fridays from 18:00 for a full 24 hours (equal times). 9 Jan 2026 is a Friday. */
function block(overrides: Partial<AvailabilityBlock> = {}): AvailabilityBlock {
  return {
    id: 'blk-1',
    unitId: UNIT_ID,
    nurseId: 'ann',
    weekdays: [5],
    startTime: '18:00',
    endTime: '18:00',
    reason: REASON,
    ...overrides,
  };
}

function findings(
  assignments: ReturnType<typeof assign>[],
  blocks: AvailabilityBlock[],
  params = { onCallCounts: true },
) {
  const s = scenario({ nurses: [ann()], assignments, availabilityBlocks: blocks });
  return accommodationBlocksRule.evaluate(s.schedule, params, s.ctx);
}

describe('a nurse keeping the Sabbath from Friday 18:00 to Saturday 18:00', () => {
  it('cannot work the Friday night', () => {
    const found = findings([assign('ann', NIGHT_12, '2026-01-09')], [block()]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'works_during_accommodation',
      severity: 'hard',
      nurseIds: ['ann'],
      dates: ['2026-01-09'],
    });
  });

  it('cannot work the Friday day shift that runs past 18:00', () => {
    // 07:00-19:00 overlaps 18:00-19:00 of the block.
    expect(findings([assign('ann', DAY_12, '2026-01-09')], [block()])).toHaveLength(1);
  });

  it('may work a Thursday night that ends Friday at 07:00', () => {
    expect(findings([assign('ann', NIGHT_12, '2026-01-08')], [block()])).toHaveLength(0);
  });

  it('may work a shift that ends exactly when the block starts', () => {
    // Day 07:00-19:00 against a block that starts at 19:00: half-open, no overlap.
    const found = findings(
      [assign('ann', DAY_12, '2026-01-09')],
      [block({ startTime: '19:00', endTime: '19:00' })],
    );
    expect(found).toHaveLength(0);
  });

  it('cannot work the Saturday day shift inside the Sabbath', () => {
    // The occurrence is dated Friday; Saturday 07:00-19:00 overlaps its last 11 hours.
    const found = findings([assign('ann', DAY_12, '2026-01-10')], [block()]);
    expect(found).toHaveLength(1);
    expect(found[0]?.dates).toEqual(['2026-01-10']);
  });

  it('may work the Saturday night that starts after the Sabbath ends', () => {
    expect(findings([assign('ann', NIGHT_12, '2026-01-10')], [block()])).toHaveLength(0);
  });

  it('may work any other weekday', () => {
    expect(findings([assign('ann', DAY_12, '2026-01-07')], [block()])).toHaveLength(0);
  });

  it('is not held to a block that has not begun or has ended', () => {
    const fri = [assign('ann', NIGHT_12, '2026-01-09')];
    expect(findings(fri, [block({ startsOn: isoDate('2026-01-10') })])).toHaveLength(0);
    expect(findings(fri, [block({ endsOn: isoDate('2026-01-08') })])).toHaveLength(0);
  });

  it('still bars the Saturday day shift when the block’s last occurrence is the Friday', () => {
    // Fri 9 Jan 18:00 to Sat 18:00 is the last occurrence; the Saturday shift is dated outside it.
    const found = findings(
      [assign('ann', DAY_12, '2026-01-10')],
      [block({ endsOn: isoDate('2026-01-09') })],
    );
    expect(found).toHaveLength(1);
  });

  it('is held to a block on its first and last day', () => {
    const fri = [assign('ann', NIGHT_12, '2026-01-09')];
    expect(findings(fri, [block({ startsOn: isoDate('2026-01-09') })])).toHaveLength(1);
    expect(findings(fri, [block({ endsOn: isoDate('2026-01-09') })])).toHaveLength(1);
  });

  it('cannot work a shift that runs into a block dated the next day', () => {
    // Block Sat 05:00-09:00; Friday night ends Saturday 07:00, so it overlaps two hours.
    const early = block({ weekdays: [6], startTime: '05:00', endTime: '09:00' });
    expect(findings([assign('ann', NIGHT_12, '2026-01-09')], [early])).toHaveLength(1);
  });

  it('is not flagged for a colleague’s block', () => {
    const other = block({ nurseId: 'bo' });
    expect(findings([assign('ann', NIGHT_12, '2026-01-09')], [other])).toHaveLength(0);
  });
});

describe('standby inside an accommodation', () => {
  const standby = () => [assign('ann', ON_CALL, '2026-01-09')];

  it('counts by default', () => {
    expect(findings(standby(), [block()])).toHaveLength(1);
  });

  it('is allowed when the unit turns that off', () => {
    expect(findings(standby(), [block()], { onCallCounts: false })).toHaveLength(0);
  });
});

describe('a block whose end is before its start', () => {
  it('runs past midnight into the next day', () => {
    // Fri 22:00 to Sat 06:00: the Saturday day shift (07:00) is clear, Friday night is not.
    const late = block({ startTime: '22:00', endTime: '06:00' });
    expect(findings([assign('ann', NIGHT_12, '2026-01-09')], [late])).toHaveLength(1);
    expect(findings([assign('ann', DAY_12, '2026-01-10')], [late])).toHaveLength(0);
  });

  it('a block whose end equals its start covers 24 hours', () => {
    const friday = dayNumber(isoDate('2026-01-09')) * MINUTES_PER_DAY;
    const occ = blockOccurrencesOverlapping(
      block(),
      { startMinute: friday + 19 * 60, endMinute: friday + 31 * 60 },
      isoDate('2026-01-09'),
    );
    expect(occ).toHaveLength(1);
    expect(occ[0]!.endMinute - occ[0]!.startMinute).toBe(1440);
    expect(occ[0]!.startMinute).toBe(dayNumber('2026-01-09' as IsoDate) * 1440 + 18 * 60);
  });
});

describe('what an accommodation says on the grid', () => {
  it('names the nurse, shift, date and blocked time but never the reason', () => {
    const found = findings([assign('ann', NIGHT_12, '2026-01-09')], [block()]);
    expect(found[0]?.message).toBe(
      'Ann Lee is scheduled on the Night 12 on Fri Jan 9 inside a recorded accommodation ' +
        '(Fri 18:00 – Sat 18:00).',
    );
    expect(JSON.stringify(found)).not.toMatch(/Sabbath|religious|4471/);
    for (const value of Object.values(found[0]?.details ?? {})) {
      expect(String(value)).not.toContain(REASON);
    }
  });

  it('only flags shifts in the period, not the lookback tail', () => {
    const s = scenario({
      nurses: [ann()],
      priorAssignments: [assign('ann', NIGHT_12, '2026-01-02')],
      availabilityBlocks: [block({ weekdays: [5] })],
    });
    // 2 Jan 2026 is a Friday.
    expect(
      accommodationBlocksRule.evaluate(s.schedule, { onCallCounts: true }, s.ctx),
    ).toHaveLength(0);
  });

  it('blockedAt hands back the block that holds the shift', () => {
    const s = scenario({ nurses: [ann()], availabilityBlocks: [block()] });
    const window = {
      startMinute: dayNumber(isoDate('2026-01-09')) * 1440 + 19 * 60,
      endMinute: dayNumber(isoDate('2026-01-09')) * 1440 + 31 * 60,
    };
    expect(blockedAt(s.ctx, 'ann', window, isoDate('2026-01-09'))?.id).toBe('blk-1');
    expect(blockedAt(s.ctx, 'bo', window, isoDate('2026-01-09'))).toBeUndefined();
  });
});
