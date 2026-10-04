/**
 * The Requests page through the IPC handlers: time off, the auto-resolve policy and shift
 * exchanges. A decision and the audit row that quotes its reason commit together; a denial with
 * no reason is refused before it touches the request, because that text is what gets quoted if
 * the decision is grieved.
 */

import { addDays } from '@shiftnurse/core';
import {
  auditHistoryFor,
  listAssignmentsForPeriod,
  listCredentials,
  listNurseCredentials,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestsApi } from './requests.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

const api = () => requestsApi(f.handle.db);
const auditsOf = (type: string, id: string) => auditHistoryFor(f.handle.db, type, id);
const draft = () => f.seeded.draftPeriodId;

function annAsksForLeave(date = addDays(f.seeded.draftStart, 3)) {
  return api().timeOff.create({
    nurseId: f.rns[0]!.id,
    startDate: date,
    endDate: date,
    type: 'pto',
    paidHours: 12,
  });
}

describe('time-off requests', () => {
  it('enters a request for the manager and lists it as pending', () => {
    const request = annAsksForLeave();
    expect(request.status).toBe('pending');
    expect(request.enteredBy).toBe('manager');
    expect(
      api()
        .timeOff.list(f.seeded.unitId, 'pending')
        .map((r) => r.id),
    ).toContain(request.id);
    expect(auditsOf('time_off_request', request.id)[0]!.action).toBe('create');
  });

  it('finds a request that overlaps a date range, and not one that does not', () => {
    const request = annAsksForLeave();
    const day = request.startDate;
    const hit = api().timeOff.listInRange(f.seeded.unitId, day, day);
    expect(hit.map((r) => r.id)).toContain(request.id);
    const miss = api().timeOff.listInRange(f.seeded.unitId, addDays(day, 10), addDays(day, 11));
    expect(miss.map((r) => r.id)).not.toContain(request.id);
  });

  it('refuses paid hours on unpaid leave in words', () => {
    const date = addDays(f.seeded.draftStart, 3);
    expect(() =>
      api().timeOff.create({
        nurseId: f.rns[0]!.id,
        startDate: date,
        endDate: date,
        type: 'unpaid',
        paidHours: 8,
      }),
    ).toThrow(/unpaid leave cannot carry paid hours/i);
  });

  it('takes Ann off the draft when her leave is approved, in the same decision', () => {
    const date = addDays(f.seeded.draftStart, 3);
    scheduleApi(f.handle.db).createAssignment({
      periodId: draft(),
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date,
    });
    const request = annAsksForLeave(date);
    const outcome = api().timeOff.approve(request.id, 'Booked months ago');
    expect(outcome.request.status).toBe('approved');
    expect(outcome.lifted).toHaveLength(1);
    expect(
      listAssignmentsForPeriod(f.handle.db, draft()).filter((a) => a.nurseId === f.rns[0]!.id),
    ).toEqual([]);
    expect(auditsOf('time_off_request', request.id)[0]).toMatchObject({
      action: 'approve',
      reason: 'Booked months ago',
    });
  });

  it('refuses to deny a request without a reason and leaves it pending', () => {
    const request = annAsksForLeave();
    expect(() => api().timeOff.deny(request.id, '')).toThrow(/reason/i);
    expect(
      api()
        .timeOff.list(f.seeded.unitId, 'pending')
        .map((r) => r.id),
    ).toContain(request.id);
  });

  it('denies with the manager’s reason quoted in the audit log', () => {
    const request = annAsksForLeave();
    const denied = api().timeOff.deny(request.id, 'Two others already off that day');
    expect(denied.status).toBe('denied');
    expect(auditsOf('time_off_request', request.id)[0]).toMatchObject({
      action: 'deny',
      reason: 'Two others already off that day',
    });
  });

  it('cancels a request the nurse no longer wants', () => {
    const request = annAsksForLeave();
    expect(api().timeOff.cancel(request.id, 'Plans changed').status).toBe('cancelled');
    expect(auditsOf('time_off_request', request.id)[0]!.reason).toBe('Plans changed');
  });

  it('withdraws an approval, but only one that was granted', () => {
    const request = annAsksForLeave();
    expect(() => api().timeOff.withdrawApproval(request.id, 'Mistake')).toThrow(
      /not approved; nothing to withdraw/i,
    );
    api().timeOff.approve(request.id);
    expect(api().timeOff.withdrawApproval(request.id, 'Census spike').status).toBe('pending');
  });

  it('says so when deciding a request that does not exist', () => {
    expect(() => api().timeOff.deny('missing', 'no')).toThrow(/not found/i);
    expect(() => api().timeOff.cancel('missing')).toThrow(/not found/i);
  });

  it('shows which of Ann’s shifts approval would orphan before the manager decides', () => {
    const date = addDays(f.seeded.draftStart, 3);
    const shift = scheduleApi(f.handle.db).createAssignment({
      periodId: draft(),
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date,
    });
    const request = annAsksForLeave(date);
    const impact = api().timeOff.impact(draft(), request.id, 'approved');
    expect(impact.displacedAssignments.map((a) => a.id)).toEqual([shift.id]);
    // Looking is not deciding: the request is still pending and the shift still there.
    expect(
      api()
        .timeOff.list(f.seeded.unitId, 'pending')
        .map((r) => r.id),
    ).toContain(request.id);
    expect(listAssignmentsForPeriod(f.handle.db, draft())).toHaveLength(1);
  });

  it('offers cover for the shift leave would free, then approves and covers in one step', () => {
    const date = addDays(f.seeded.draftStart, 3);
    const shift = scheduleApi(f.handle.db).createAssignment({
      periodId: draft(),
      nurseId: f.rns[0]!.id,
      shiftTypeId: f.day.id,
      date,
    });
    const request = annAsksForLeave(date);
    const [option] = api().timeOff.coverOptions(draft(), request.id);
    const cover = option!.candidates[0]!.nurseId;
    api().timeOff.approveAndCover(draft(), request.id, 'Short notice', [
      { assignmentId: shift.id, nurseId: cover },
    ]);
    const onDay = listAssignmentsForPeriod(f.handle.db, draft()).filter((a) => a.date === date);
    expect(onDay.map((a) => a.nurseId)).toEqual([cover]);
    expect(
      api()
        .timeOff.list(f.seeded.unitId, 'approved')
        .map((r) => r.id),
    ).toContain(request.id);
  });
});

describe('the auto-resolve policy and conflicts', () => {
  it('is off until the manager switches it on, and keeps the thresholds she set', () => {
    expect(api().conflicts.policy(f.seeded.unitId).enabled).toBe(false);
    const saved = api().conflicts.savePolicy(f.seeded.unitId, {
      enabled: true,
      maxCostDelta: 250,
      maxFairnessDrop: 4,
    });
    expect(saved).toEqual({ enabled: true, maxCostDelta: 250, maxFairnessDrop: 4 });
    expect(api().conflicts.policy(f.seeded.unitId)).toEqual(saved);
  });

  it('refuses a negative cost ceiling in words and keeps the saved policy', () => {
    expect(() =>
      api().conflicts.savePolicy(f.seeded.unitId, {
        enabled: true,
        maxCostDelta: -1,
        maxFairnessDrop: 4,
      }),
    ).toThrow(/zero or positive/i);
    expect(api().conflicts.policy(f.seeded.unitId).enabled).toBe(false);
  });
});

describe('shift exchanges', () => {
  // The unit's day shift needs a PRECEPTOR on it, and the seeded ids are random, so the two
  // nurses are chosen by credential: a handover between two preceptors cannot leave it short.
  function preceptors(): [(typeof f.rns)[0], (typeof f.rns)[0]] {
    const code = listCredentials(f.handle.db).find((c) => c.code === 'PRECEPTOR')!;
    const held = f.rns.filter((n) =>
      listNurseCredentials(f.handle.db, n.id).some((c) => c.credentialId === code.id),
    );
    expect(held.length, 'the scenario unit needs two preceptor RNs').toBeGreaterThanOrEqual(2);
    return [held[0]!, held[1]!];
  }

  function annGivesAwayToBea() {
    const [ann, bea] = preceptors();
    const date = addDays(f.seeded.draftStart, 2);
    const shift = scheduleApi(f.handle.db).createAssignment({
      periodId: draft(),
      nurseId: ann.id,
      shiftTypeId: f.day.id,
      date,
    });
    const proposal = {
      kind: 'giveaway' as const,
      requestingNurseId: ann.id,
      counterpartyNurseId: bea.id,
      offeredAssignmentId: shift.id,
    };
    return { date, shift, proposal, ann, bea };
  }

  it('records a proposed giveaway and judges it before anyone decides', () => {
    const { proposal } = annGivesAwayToBea();
    const verdict = api().exchange.evaluate(draft(), proposal);
    expect(['ok', 'warn']).toContain(verdict.verdict);
    const swap = api().exchange.propose(draft(), proposal, 'Ann has a recital');
    expect(swap.status).toBe('proposed');
    expect(
      api()
        .exchange.list(f.seeded.unitId, 'proposed')
        .map((s) => s.id),
    ).toContain(swap.id);
    expect(
      api()
        .exchange.listForPeriod(draft(), 'proposed')
        .map((s) => s.id),
    ).toContain(swap.id);
    expect(auditsOf('shift_swap', swap.id)[0]!.action).toBe('create');
  });

  it('hands the shift to Bea on approval and audits the decision', () => {
    const { date, shift, proposal, bea } = annGivesAwayToBea();
    const swap = api().exchange.propose(draft(), proposal);
    api().exchange.approve(swap.id, 'Both agreed');
    const onDay = listAssignmentsForPeriod(f.handle.db, draft()).filter((a) => a.date === date);
    expect(onDay.map((a) => a.nurseId)).toEqual([bea.id]);
    expect(onDay.map((a) => a.id)).not.toContain(shift.id);
    expect(
      api()
        .exchange.list(f.seeded.unitId, 'approved')
        .map((s) => s.id),
    ).toContain(swap.id);
    expect(auditsOf('shift_swap', swap.id)[0]!.action).toBe('approve');
  });

  it('refuses to deny an exchange without a reason, then denies with one', () => {
    const { proposal } = annGivesAwayToBea();
    const swap = api().exchange.propose(draft(), proposal);
    expect(() => api().exchange.deny(swap.id, '')).toThrow(/reason/i);
    expect(
      api()
        .exchange.list(f.seeded.unitId, 'proposed')
        .map((s) => s.id),
    ).toContain(swap.id);
    expect(api().exchange.deny(swap.id, 'Bea is on nights').status).toBe('denied');
    expect(auditsOf('shift_swap', swap.id)[0]).toMatchObject({
      action: 'deny',
      reason: 'Bea is on nights',
    });
  });

  it('cancels a proposal, and will not cancel it twice', () => {
    const { proposal } = annGivesAwayToBea();
    const swap = api().exchange.propose(draft(), proposal);
    expect(api().exchange.cancel(swap.id, 'Withdrawn').status).toBe('cancelled');
    expect(() => api().exchange.cancel(swap.id)).toThrow(/cancelled, not proposed/i);
  });
});
