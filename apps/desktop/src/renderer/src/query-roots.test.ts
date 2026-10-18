// @vitest-environment jsdom
/**
 * A key outside every named root is a key no write can reach: the screen showing it stays on
 * its first answer until the app restarts. So every factory the hooks build keys with is called
 * here and its key checked against `queryRoots`. jsdom because `api.ts` reads `window.shiftnurse`.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { queryKeys } from './api.js';
import { configKeys } from './api-config.js';
import { costKeys } from './api-cost.js';
import { dayOfPayKeys } from './api-day-of-pay.js';
import { dayOfKeys } from './api-dayof.js';
import { demandQueryKeys } from './api-demand.js';
import { exchangeKeys } from './api-exchange.js';
import { fairnessQueryKeys } from './api-fairness.js';
import { floatOutKeys } from './api-float-out.js';
import { leaveKeys } from './api-leave-balances.js';
import { leaveBidKeys } from './api-leave-bidding.js';
import { nurseUnitKeys } from './api-nurse-units.js';
import { publishKeys } from './api-publish.js';
import { requestKeys } from './api-requests.js';
import { scheduleKeys } from './api-schedule.js';
import { setupKeys } from './api-setup.js';
import { solverKeys } from './api-solver.js';
import { queryRoots } from './query-roots.js';

const factories: Record<string, Record<string, unknown>> = {
  queryKeys,
  configKeys,
  costKeys,
  dayOfPayKeys,
  exchangeKeys,
  demandQueryKeys,
  dayOfKeys,
  leaveKeys,
  leaveBidKeys,
  fairnessQueryKeys,
  floatOutKeys,
  requestKeys,
  publishKeys,
  scheduleKeys,
  solverKeys,
  setupKeys,
  nurseUnitKeys,
};

const FLOAT_ORDER = { periodId: 'x', date: 'x', shiftTypeId: 'x', role: 'rn', volunteers: [] };

function keyOf(group: string, name: string, value: unknown): readonly unknown[] {
  if (typeof value !== 'function') return value as readonly unknown[];
  if (group === 'floatOutKeys' && name === 'order') return value(FLOAT_ORDER);
  return value(...Array.from({ length: value.length }, () => 'x'));
}

const startsWith = (key: readonly unknown[], root: readonly string[]) =>
  root.every((segment, i) => key[i] === segment);

describe('cache keys', () => {
  it('every cache key the app builds starts with a named root', () => {
    const roots = Object.values(queryRoots) as readonly (readonly string[])[];
    const orphans: string[] = [];
    for (const [group, members] of Object.entries(factories)) {
      for (const [name, value] of Object.entries(members)) {
        const key = keyOf(group, name, value);
        if (!roots.some((root) => startsWith(key, root))) orphans.push(`${group}.${name}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('a spread root keeps the key a literal tuple, so a typo in a key is a type error', () => {
    expectTypeOf(scheduleKeys.validation('p1')).toEqualTypeOf<readonly ['validation', string]>();
    expectTypeOf(costKeys.report('p1')).toEqualTypeOf<readonly ['cost', 'report', string]>();
  });
});
