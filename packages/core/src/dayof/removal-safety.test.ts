/**
 * Who the shift cannot spare, worked by hand. Day 12 on Tue 6 Jan 2026, in a period of 4–17 Jan.
 * The floor asks for one RN unless a test says otherwise — the skill mix is judged only on a shift
 * that requires staff — so with two or more RNs on, nothing here is short on numbers.
 */

import { describe, expect, it } from 'vitest';
import type { Preceptorship } from '../domain/entities.js';
import { isoDate } from '../domain/time.js';
import {
  assign,
  CRED_ACLS,
  coverage,
  credentialRequirement,
  DAY_12,
  makeNurse,
  nurseCredential,
  type SolveScenarioOptions,
  solveInputFrom,
  UNIT_ID,
} from '../testing/fixtures.js';
import { cancellationOrder, DEFAULT_CANCELLATION_TIERS } from './cancellation.js';
import { removalBreaks } from './removal-safety.js';

const START = isoDate('2026-01-04');
const END = isoDate('2026-01-17');
const TUE = '2026-01-06';

function inputWith(options: Partial<SolveScenarioOptions>) {
  return solveInputFrom({
    startDate: START,
    endDate: END,
    shiftTypes: [DAY_12],
    coverageRequirements: [coverage(DAY_12, 'RN', 1, 1, 2)],
    ...options,
  });
}

describe('who the shift cannot spare', () => {
  it('names the only experienced RN beside two new grads as unsafe to remove', () => {
    const exp = makeNurse({ id: 'exp' });
    const nov1 = makeNurse({ id: 'nov1', isNovice: true });
    const nov2 = makeNurse({ id: 'nov2', isNovice: true });
    const rows = [exp, nov1, nov2].map((n) => assign(n.id, DAY_12, TUE));
    const input = inputWith({ nurses: [exp, nov1, nov2], assignments: rows });

    const breaks = removalBreaks(
      input,
      rows.map((r) => r.id),
    );
    // One experienced RN is required by default: without Exp, 0 stand beside a new grad; without
    // a new grad, Exp still does.
    expect([...breaks.keys()]).toEqual([rows[0]!.id]);
    expect(breaks.get(rows[0]!.id)!.code).toBe('all_novice_shift');
  });

  it('names an orientee’s preceptor as unsafe to remove', () => {
    const pre = makeNurse({ id: 'pre' });
    const ori = makeNurse({ id: 'ori' });
    const x = makeNurse({ id: 'x' });
    const rows = [pre, ori, x].map((n) => assign(n.id, DAY_12, TUE));
    const preceptorship: Preceptorship = {
      id: 'pc-1',
      unitId: UNIT_ID,
      orienteeId: 'ori',
      preceptorId: 'pre',
      startDate: START,
      endDate: END,
    };
    const input = inputWith({
      nurses: [pre, ori, x],
      assignments: rows,
      preceptorships: [preceptorship],
    });

    const breaks = removalBreaks(
      input,
      rows.map((r) => r.id),
    );
    expect([...breaks.keys()]).toEqual([rows[0]!.id]);
    expect(breaks.get(rows[0]!.id)!.code).toBe('orientee_without_preceptor');
  });

  it('keeps the only ACLS nurse on a shift that needs one, and sends home the next nurse', () => {
    const acls = makeNurse({ id: 'acls', firstName: 'Ada', lastName: 'Lowe' });
    const r2 = makeNurse({ id: 'r2', firstName: 'Ben', lastName: 'Ray' });
    const r3 = makeNurse({ id: 'r3', firstName: 'Cal', lastName: 'Ito' });
    const nurses = [acls, r2, r3];
    const rows = nurses.map((n) => assign(n.id, DAY_12, TUE));
    const input = inputWith({
      nurses,
      assignments: rows,
      nurseCredentials: [nurseCredential('acls', CRED_ACLS)],
      shiftCredentialRequirements: [credentialRequirement(CRED_ACLS, 1, { shiftType: DAY_12 })],
    });

    const breaks = removalBreaks(
      input,
      rows.map((r) => r.id),
    );
    // One ACLS holder required and Ada is the only one: without her 0 hold it, short by 1. Without
    // Ben or Cal, Ada still does.
    expect([...breaks.keys()]).toEqual([rows[0]!.id]);
    expect(breaks.get(rows[0]!.id)).toMatchObject({ code: 'missing_credential', amount: 1 });

    // Ada offers to go first; she is kept, and the next in the order goes instead.
    const order = cancellationOrder({
      unitId: UNIT_ID,
      onShift: nurses.map((nurse, i) => ({ nurse, assignment: rows[i]! })),
      tiers: DEFAULT_CANCELLATION_TIERS,
      volunteers: ['acls', 'r3'],
      history: new Map(),
      removalBreaks: breaks,
    });
    expect(order.excluded.map((e) => e.nurseId)).toEqual(['acls']);
    expect(order.excluded[0]!.reason).toMatch(
      /^Sending Ada Lowe home would leave the shift breaking a hard rule — /,
    );
    expect(order.order[0]).toMatchObject({ nurseId: 'r3', tier: 'volunteer' });
  });

  it('does not count a census-judged shortfall against a removal', () => {
    const nurses = [makeNurse({ id: 'r1' }), makeNurse({ id: 'r2' }), makeNurse({ id: 'r3' })];
    const rows = nurses.map((n) => assign(n.id, DAY_12, TUE));
    const input = inputWith({
      nurses,
      assignments: rows,
      coverageRequirements: [coverage(DAY_12, 'RN', 3, 3, 2)],
    });
    // Sending any one home leaves 2 of a planned 3: `understaffed`, which Today judges against
    // the census on the floor instead.
    expect(
      removalBreaks(
        input,
        rows.map((r) => r.id),
      ).size,
    ).toBe(0);
  });

  it('blames a removal that deepens an existing breach', () => {
    const e1 = makeNurse({ id: 'e1' });
    const e2 = makeNurse({ id: 'e2' });
    const n1 = makeNurse({ id: 'n1', isNovice: true });
    const n2 = makeNurse({ id: 'n2', isNovice: true });

    // Two required, two stand: no breach yet. Removing either experienced RN introduces one.
    const fresh = [e1, e2, n1].map((n) => assign(n.id, DAY_12, TUE));
    const clean = removalBreaks(
      inputWith({
        nurses: [e1, e2, n1],
        assignments: fresh,
        ruleParams: { 'coverage-minimums': { minExperiencedPerShift: 2 } },
      }),
      fresh.map((r) => r.id),
    );
    expect([...clean.keys()]).toEqual([fresh[0]!.id, fresh[1]!.id]);

    // Three required, two stand: short by 1 already. Without an experienced RN it is short by
    // 2, which is worse; without one new grad the other still stands and it stays short by 1.
    const rows = [e1, e2, n1, n2].map((n) => assign(n.id, DAY_12, TUE));
    const breaks = removalBreaks(
      inputWith({
        nurses: [e1, e2, n1, n2],
        assignments: rows,
        ruleParams: { 'coverage-minimums': { minExperiencedPerShift: 3 } },
      }),
      rows.map((r) => r.id),
    );
    expect([...breaks.keys()]).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(breaks.get(rows[0]!.id)).toMatchObject({ code: 'all_novice_shift', amount: 2 });
  });

  it('refuses an assignment that is not in the period', () => {
    const input = inputWith({ nurses: [makeNurse({ id: 'solo' })] });
    expect(() => removalBreaks(input, ['nope'])).toThrow('Unknown assignment nope.');
  });
});

describe('a past shift judged by the rules of its day', () => {
  it('still names the only experienced RN as unsafe to remove on a shift type retired since', () => {
    const exp = makeNurse({ id: 'exp' });
    const nov1 = makeNurse({ id: 'nov1', isNovice: true });
    const nov2 = makeNurse({ id: 'nov2', isNovice: true });
    const rows = [exp, nov1, nov2].map((n) => assign(n.id, DAY_12, TUE));
    const judged = inputWith({ nurses: [exp, nov1, nov2], assignments: rows });
    // Main hands over the live types, Day 12 retired since, with the demand of that Tuesday.
    const input = {
      ...judged,
      shiftTypes: judged.shiftTypes.map((t) => (t.id === DAY_12.id ? { ...t, active: false } : t)),
    };
    const breaks = removalBreaks(
      input,
      rows.map((r) => r.id),
    );
    expect([...breaks.keys()]).toEqual([rows[0]!.id]);
    expect(breaks.get(rows[0]!.id)!.code).toBe('all_novice_shift');
  });
});
