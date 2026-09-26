/**
 * Repository tests for time-off requests.
 *
 * These exercise the behaviour that is easy to get quietly wrong: the reason requirement on
 * denial, and the overlap arithmetic shared by the solver's hard-availability constraint and
 * the manager's overlapping-requests heatmap.
 */

import { isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createUnit } from './config.js';
import { createNurse } from './roster.js';
import {
  approvedTimeOffInRange,
  approveTimeOff,
  cancelTimeOff,
  countDecisionsByNurse,
  createTimeOffRequest,
  denyTimeOff,
  getTimeOffRequest,
  listTimeOffOverlappingForUnit,
  withdrawApproval,
} from './timeoff.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;

function mkNurse(firstName: string): string {
  return createNurse(
    handle.db,
    {
      unitId,
      employeeId: `E${Math.random().toString().slice(2, 8)}`,
      firstName,
      lastName: 'Nurse',
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: isoDate('2020-01-01'),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  ).id;
}

function request(nurseId: string, startDate: string, endDate: string) {
  return createTimeOffRequest(
    handle.db,
    { nurseId, startDate: isoDate(startDate), endDate: isoDate(endDate), type: 'pto' },
    ACTOR,
  );
}

beforeEach(() => {
  handle = openTestDatabase();
  const unit = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  );
  unitId = unit.id;
});

afterEach(() => handle.close());

describe('creating a request', () => {
  it("defaults enteredBy to 'manager'", () => {
    const nurseId = mkNurse('Ada');
    const created = request(nurseId, '2026-02-01', '2026-02-05');
    expect(created.enteredBy).toBe('manager');
    expect(created.status).toBe('pending');
  });
});

describe('approving', () => {
  it('sets status, decidedAt and decidedBy', () => {
    const nurseId = mkNurse('Ada');
    const created = request(nurseId, '2026-02-01', '2026-02-05');
    const approved = approveTimeOff(handle.db, created.id, ACTOR);
    expect(approved.status).toBe('approved');
    expect(approved.decidedAt).toBeTypeOf('number');
    expect(approved.decidedBy).toBe(ACTOR);
  });
});

describe('denying', () => {
  it('refuses a denial with no stated reason, leaving the request unchanged', () => {
    const nurseId = mkNurse('Ada');
    const created = request(nurseId, '2026-02-01', '2026-02-05');
    expect(() => denyTimeOff(handle.db, created.id, ACTOR, '')).toThrow(/requires a reason/i);
    expect(getTimeOffRequest(handle.db, created.id)?.status).toBe('pending');
  });

  it('refuses a denial whose reason is only whitespace, leaving the request unchanged', () => {
    const nurseId = mkNurse('Ada');
    const created = request(nurseId, '2026-02-01', '2026-02-05');
    expect(() => denyTimeOff(handle.db, created.id, ACTOR, '   ')).toThrow(/requires a reason/i);
    expect(getTimeOffRequest(handle.db, created.id)?.status).toBe('pending');
  });

  it('succeeds with a real reason and stores it as decisionReason', () => {
    const nurseId = mkNurse('Ada');
    const created = request(nurseId, '2026-02-01', '2026-02-05');
    const denied = denyTimeOff(
      handle.db,
      created.id,
      ACTOR,
      'Would leave the unit below minimum staffing',
    );
    expect(denied.status).toBe('denied');
    expect(denied.decisionReason).toBe('Would leave the unit below minimum staffing');
  });
});

describe('approvedTimeOffInRange', () => {
  const windowStart = '2026-03-10';
  const windowEnd = '2026-03-20';

  it('returns only approved requests overlapping the window', () => {
    const nurseId = mkNurse('Ada');
    const pending = request(nurseId, '2026-03-12', '2026-03-14');
    const approved = request(nurseId, '2026-03-15', '2026-03-16');
    approveTimeOff(handle.db, approved.id, ACTOR);

    const result = approvedTimeOffInRange(
      handle.db,
      unitId,
      isoDate(windowStart),
      isoDate(windowEnd),
    );
    expect(result.map((r) => r.id)).toEqual([approved.id]);
    expect(result.map((r) => r.id)).not.toContain(pending.id);
  });

  it('excludes a request fully before the window', () => {
    const nurseId = mkNurse('Ada');
    const before = request(nurseId, '2026-02-01', '2026-02-05');
    approveTimeOff(handle.db, before.id, ACTOR);
    expect(
      approvedTimeOffInRange(handle.db, unitId, isoDate(windowStart), isoDate(windowEnd)),
    ).toHaveLength(0);
  });

  it('excludes a request fully after the window', () => {
    const nurseId = mkNurse('Ada');
    const after = request(nurseId, '2026-04-01', '2026-04-05');
    approveTimeOff(handle.db, after.id, ACTOR);
    expect(
      approvedTimeOffInRange(handle.db, unitId, isoDate(windowStart), isoDate(windowEnd)),
    ).toHaveLength(0);
  });

  it('includes a request overlapping only the start edge', () => {
    const nurseId = mkNurse('Ada');
    const overlapStart = request(nurseId, '2026-03-05', windowStart);
    approveTimeOff(handle.db, overlapStart.id, ACTOR);
    const result = approvedTimeOffInRange(
      handle.db,
      unitId,
      isoDate(windowStart),
      isoDate(windowEnd),
    );
    expect(result.map((r) => r.id)).toEqual([overlapStart.id]);
  });

  it('includes a request overlapping only the end edge', () => {
    const nurseId = mkNurse('Ada');
    const overlapEnd = request(nurseId, windowEnd, '2026-03-25');
    approveTimeOff(handle.db, overlapEnd.id, ACTOR);
    const result = approvedTimeOffInRange(
      handle.db,
      unitId,
      isoDate(windowStart),
      isoDate(windowEnd),
    );
    expect(result.map((r) => r.id)).toEqual([overlapEnd.id]);
  });

  it('includes a request that fully contains the window', () => {
    const nurseId = mkNurse('Ada');
    const containing = request(nurseId, '2026-03-01', '2026-03-31');
    approveTimeOff(handle.db, containing.id, ACTOR);
    const result = approvedTimeOffInRange(
      handle.db,
      unitId,
      isoDate(windowStart),
      isoDate(windowEnd),
    );
    expect(result.map((r) => r.id)).toEqual([containing.id]);
  });
});

describe('listTimeOffOverlappingForUnit boundaries', () => {
  it('counts a request ending exactly on the window start as overlapping', () => {
    const nurseId = mkNurse('Ada');
    const req = request(nurseId, '2026-03-01', '2026-03-10');
    const result = listTimeOffOverlappingForUnit(
      handle.db,
      unitId,
      isoDate('2026-03-10'),
      isoDate('2026-03-20'),
    );
    expect(result.map((r) => r.id)).toContain(req.id);
  });

  it('counts a request starting exactly on the window end as overlapping', () => {
    const nurseId = mkNurse('Ada');
    const req = request(nurseId, '2026-03-20', '2026-03-25');
    const result = listTimeOffOverlappingForUnit(
      handle.db,
      unitId,
      isoDate('2026-03-10'),
      isoDate('2026-03-20'),
    );
    expect(result.map((r) => r.id)).toContain(req.id);
  });
});

describe('listTimeOffOverlappingForUnit', () => {
  it('returns pending and denied requests too, but only for this unit', () => {
    const ada = mkNurse('Ada');
    const pending = request(ada, '2026-03-05', '2026-03-06');
    const denied = denyTimeOff(handle.db, request(ada, '2026-03-07', '2026-03-08').id, ACTOR, 'x');
    const outside = request(ada, '2026-04-01', '2026-04-02');
    const otherUnit = createUnit(
      handle.db,
      {
        name: '5 East',
        unitType: 'Telemetry',
        payPeriodDays: 14,
        payPeriodAnchor: isoDate('2026-01-04'),
      },
      ACTOR,
    );
    const stranger = createNurse(
      handle.db,
      {
        unitId: otherUnit.id,
        employeeId: 'E999999',
        firstName: 'Zed',
        lastName: 'Other',
        role: 'RN',
        employmentType: 'full_time',
        fte: 1,
        contractedHoursPerPeriod: 72,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: false,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      ACTOR,
    );
    const foreign = request(stranger.id, '2026-03-05', '2026-03-06');

    const ids = listTimeOffOverlappingForUnit(
      handle.db,
      unitId,
      isoDate('2026-03-01'),
      isoDate('2026-03-31'),
    ).map((r) => r.id);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(denied.id);
    expect(ids).not.toContain(outside.id);
    expect(ids).not.toContain(foreign.id);
  });
});

describe('withdrawApproval', () => {
  it('flips status back to pending and records a reason', () => {
    const nurseId = mkNurse('Ada');
    const created = request(nurseId, '2026-02-01', '2026-02-05');
    approveTimeOff(handle.db, created.id, ACTOR);

    const withdrawn = withdrawApproval(handle.db, created.id, ACTOR, 'Unit fell below minimum');
    expect(withdrawn.status).toBe('pending');
    expect(withdrawn.decidedAt).toBeUndefined();

    const history = auditHistoryFor(handle.db, 'time_off_request', created.id);
    expect(history[0]?.reason).toBe('Unit fell below minimum');
  });

  it('refuses to withdraw a request that was never approved', () => {
    const nurseId = mkNurse('Ada');
    const created = request(nurseId, '2026-02-01', '2026-02-05');
    expect(() => withdrawApproval(handle.db, created.id, ACTOR, 'reason')).toThrow();
  });
});

describe('cancelTimeOff', () => {
  it('cancels a pending request', () => {
    const nurseId = mkNurse('Ada');
    const created = request(nurseId, '2026-02-01', '2026-02-05');
    const cancelled = cancelTimeOff(handle.db, created.id, ACTOR, 'No longer needed');
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('countDecisionsByNurse', () => {
  it('tallies approved vs denied per nurse', () => {
    const ada = mkNurse('Ada');
    const grace = mkNurse('Grace');

    const adaApproved1 = request(ada, '2026-05-01', '2026-05-02');
    approveTimeOff(handle.db, adaApproved1.id, ACTOR);
    const adaApproved2 = request(ada, '2026-05-10', '2026-05-11');
    approveTimeOff(handle.db, adaApproved2.id, ACTOR);
    const adaDenied = request(ada, '2026-05-15', '2026-05-16');
    denyTimeOff(handle.db, adaDenied.id, ACTOR, 'Coverage gap');

    const graceDenied = request(grace, '2026-05-01', '2026-05-02');
    denyTimeOff(handle.db, graceDenied.id, ACTOR, 'Coverage gap');

    const tallies = countDecisionsByNurse(handle.db, unitId, isoDate('2026-01-01'));
    expect(tallies.get(ada)).toEqual({ approved: 2, denied: 1 });
    expect(tallies.get(grace)).toEqual({ approved: 0, denied: 1 });
  });
});
