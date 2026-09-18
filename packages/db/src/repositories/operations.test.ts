/**
 * Repository tests for day-of operations: call-offs and the replacement search, effective pay
 * rate resolution, and the fairness ledger.
 */

import { type IsoDate, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor, recentAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { ids } from '../ids.js';
import * as s from '../schema.js';
import { createShiftType, createUnit, saveRuleSet } from './config.js';
import {
  cancelCallOff,
  effectiveRateForNurse,
  getFairnessLedgerEntry,
  importFairnessLedgerEntries,
  lastCalledAt,
  ledgerSince,
  listCallAttempts,
  listOpenCallOffs,
  logCallAttempt,
  markCallOffCovered,
  reportCallOff,
  upsertFairnessLedgerEntry,
} from './operations.js';
import { createNurse } from './roster.js';
import { createAssignment, createPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let shiftTypeId: string;
let periodId: string;

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

function mkAssignment(nurseId: string, date: IsoDate) {
  return createAssignment(handle.db, { periodId, nurseId, shiftTypeId, date }, ACTOR);
}

function insertPayRate(input: {
  nurseId?: string | null;
  role?: 'RN' | 'LPN' | 'CNA' | null;
  hourlyRate: number;
  effectiveFrom: IsoDate;
}): void {
  handle.db
    .insert(s.payRate)
    .values({
      id: ids.payRate(),
      nurseId: input.nurseId ?? null,
      role: input.role ?? null,
      hourlyRate: input.hourlyRate,
      effectiveFrom: input.effectiveFrom,
    })
    .run();
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
  shiftTypeId = createShiftType(
    handle.db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#f59e0b',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  const ruleSet = saveRuleSet(
    handle.db,
    {
      unitId,
      name: 'Default',
      weekendDefinition: {
        startWeekday: 6,
        startMinute: 0,
        durationMinutes: 2880,
        mode: 'starts_within',
      },
      configs: [
        {
          ruleId: 'min-rest-between-shifts',
          enabled: true,
          params: { minRestHours: 10, onCallCountsAsWork: false },
        },
      ],
    },
    ACTOR,
  );
  periodId = createPeriod(
    handle.db,
    {
      unitId,
      name: 'Test Period',
      startDate: isoDate('2026-01-15'),
      endDate: isoDate('2026-01-28'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
});

afterEach(() => handle.close());

describe('call-offs', () => {
  it('reports a call-off, marks it covered with a replacement assignment, and audits both steps', () => {
    const nurseId = mkNurse('Ada');
    const replacementNurse = mkNurse('Grace');
    const original = mkAssignment(nurseId, isoDate('2026-01-16'));

    const callOff = reportCallOff(handle.db, original.id, ACTOR, 'Sick');
    expect(callOff.status).toBe('open');

    const replacement = mkAssignment(replacementNurse, isoDate('2026-01-16'));
    const covered = markCallOffCovered(handle.db, callOff.id, replacement.id, ACTOR);
    expect(covered.status).toBe('covered');
    expect(covered.replacementAssignmentId).toBe(replacement.id);

    const callOffHistory = auditHistoryFor(handle.db, 'call_off', callOff.id);
    expect(callOffHistory.map((h) => h.action)).toEqual(
      expect.arrayContaining(['call_off', 'backfill']),
    );
  });

  it('excludes covered and cancelled call-offs from the open list', () => {
    const nurseId = mkNurse('Ada');
    const a1 = mkAssignment(nurseId, isoDate('2026-01-16'));
    const a2 = mkAssignment(nurseId, isoDate('2026-01-17'));
    const a3 = mkAssignment(nurseId, isoDate('2026-01-18'));

    const open = reportCallOff(handle.db, a1.id, ACTOR);
    const toCover = reportCallOff(handle.db, a2.id, ACTOR);
    const toCancel = reportCallOff(handle.db, a3.id, ACTOR);

    const replacementNurse = mkNurse('Grace');
    const replacement = mkAssignment(replacementNurse, isoDate('2026-01-17'));
    markCallOffCovered(handle.db, toCover.id, replacement.id, ACTOR);
    cancelCallOff(handle.db, toCancel.id, ACTOR);

    const openList = listOpenCallOffs(handle.db);
    expect(openList.map((c) => c.id)).toEqual([open.id]);
  });
});

describe('call attempts', () => {
  function insertAttempt(callOffId: string, nurseId: string, attemptedAt: number): void {
    // Inserted directly so the timestamps are controlled; `logCallAttempt` stamps Date.now().
    handle.db
      .insert(s.callAttempt)
      .values({ id: ids.callAttempt(), callOffId, nurseId, attemptedAt, outcome: 'no_answer' })
      .run();
  }

  it('lists every attempt made for a call-off', () => {
    const nurseId = mkNurse('Covering');
    const assignment = mkAssignment(nurseId, isoDate('2026-01-16'));
    const callOff = reportCallOff(handle.db, assignment.id, ACTOR);

    logCallAttempt(handle.db, callOff.id, nurseId, 'no_answer', ACTOR);
    logCallAttempt(handle.db, callOff.id, nurseId, 'declined', ACTOR);
    logCallAttempt(handle.db, callOff.id, nurseId, 'accepted', ACTOR);

    // Newest first, like the audit history — the accepted call is the one you want at the top.
    expect(listCallAttempts(handle.db, callOff.id).map((a) => a.outcome)).toEqual([
      'accepted',
      'declined',
      'no_answer',
    ]);
  });

  it('returns the most recent attempt per nurse, not the first', () => {
    // This is what stops the replacement finder phoning the same three people every time.
    const phoned = mkNurse('Phoned');
    const assignment = mkAssignment(mkNurse('Sick'), isoDate('2026-01-16'));
    const callOff = reportCallOff(handle.db, assignment.id, ACTOR);

    const earlier = Date.parse('2026-01-10T08:00:00Z');
    const later = Date.parse('2026-01-14T08:00:00Z');
    insertAttempt(callOff.id, phoned, earlier);
    insertAttempt(callOff.id, phoned, later);

    const last = lastCalledAt(handle.db, unitId, isoDate('2026-01-01'));
    expect(last.get(phoned)).toBe(later);
  });

  it('omits nurses who were never called', () => {
    const phoned = mkNurse('Phoned');
    const quiet = mkNurse('Quiet');
    const assignment = mkAssignment(mkNurse('Sick'), isoDate('2026-01-16'));
    const callOff = reportCallOff(handle.db, assignment.id, ACTOR);
    insertAttempt(callOff.id, phoned, Date.parse('2026-01-10T08:00:00Z'));

    const last = lastCalledAt(handle.db, unitId, isoDate('2026-01-01'));
    expect(last.has(phoned)).toBe(true);
    expect(last.has(quiet)).toBe(false);
  });

  it('ignores attempts older than the lookback date', () => {
    const phoned = mkNurse('Phoned');
    const assignment = mkAssignment(mkNurse('Sick'), isoDate('2026-01-16'));
    const callOff = reportCallOff(handle.db, assignment.id, ACTOR);
    insertAttempt(callOff.id, phoned, Date.parse('2025-06-01T08:00:00Z'));

    expect(lastCalledAt(handle.db, unitId, isoDate('2026-01-01')).has(phoned)).toBe(false);
  });
});

describe('effective pay rate', () => {
  it('prefers a per-nurse rate over the role default', () => {
    const nurseId = mkNurse('Paid');
    insertPayRate({ role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2025-01-01') });
    insertPayRate({ nurseId, hourlyRate: 52, effectiveFrom: isoDate('2025-01-01') });

    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      52,
    );
  });

  it('picks the latest rate that is not after the query date', () => {
    const nurseId = mkNurse('Raised');
    insertPayRate({ nurseId, hourlyRate: 45, effectiveFrom: isoDate('2024-01-01') });
    insertPayRate({ nurseId, hourlyRate: 48, effectiveFrom: isoDate('2025-07-01') });
    insertPayRate({ nurseId, hourlyRate: 51, effectiveFrom: isoDate('2026-01-15') });

    // The day before the newest raise takes effect, the previous rate still applies.
    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-14'))?.hourlyRate).toBe(
      48,
    );
    // On the effective date itself, the raise applies.
    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      51,
    );
  });

  it('ignores a rate whose effective date is still in the future', () => {
    const nurseId = mkNurse('Future');
    insertPayRate({ nurseId, hourlyRate: 45, effectiveFrom: isoDate('2025-01-01') });
    insertPayRate({ nurseId, hourlyRate: 60, effectiveFrom: isoDate('2027-01-01') });

    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      45,
    );
  });

  it('falls back to the role default when the nurse has no rate of their own', () => {
    const nurseId = mkNurse('Default');
    insertPayRate({ role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2025-01-01') });
    insertPayRate({ role: 'LPN', hourlyRate: 30, effectiveFrom: isoDate('2025-01-01') });

    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))?.hourlyRate).toBe(
      40,
    );
  });

  it('returns undefined when neither a nurse nor a role rate exists', () => {
    const nurseId = mkNurse('Unpriced');
    expect(effectiveRateForNurse(handle.db, nurseId, 'RN', isoDate('2026-01-15'))).toBeUndefined();
  });
});

describe('fairness ledger', () => {
  it('upserts in place rather than creating a duplicate row', () => {
    const nurseId = mkNurse('Tracked');
    upsertFairnessLedgerEntry(
      handle.db,
      { nurseId, periodId, periodStart: isoDate('2026-01-15'), nightShifts: 3 },
      ACTOR,
    );
    upsertFairnessLedgerEntry(
      handle.db,
      { nurseId, periodId, periodStart: isoDate('2026-01-15'), nightShifts: 5 },
      ACTOR,
    );

    const entry = getFairnessLedgerEntry(handle.db, nurseId, periodId);
    expect(entry?.nightShifts).toBe(5);
    expect(handle.db.select().from(s.fairnessLedger).all()).toHaveLength(1);
  });

  it('returns only entries from periods starting on or after the lookback date', () => {
    const nurseId = mkNurse('History');
    importFairnessLedgerEntries(
      handle.db,
      [
        { nurseId, periodId: 'old', periodStart: isoDate('2025-06-01'), nightShifts: 9 },
        { nurseId, periodId: 'recent', periodStart: isoDate('2025-12-01'), nightShifts: 2 },
        { nurseId, periodId: 'boundary', periodStart: isoDate('2025-10-01'), nightShifts: 4 },
      ],
      ACTOR,
    );

    const window = ledgerSince(handle.db, unitId, isoDate('2025-10-01'));
    expect(window.map((e) => e.periodId).sort()).toEqual(['boundary', 'recent']);
  });

  it('records historical seeding as an import in the audit log', () => {
    const nurseId = mkNurse('Imported');
    importFairnessLedgerEntries(
      handle.db,
      [
        { nurseId, periodId: 'p0', periodStart: isoDate('2025-06-01'), weekendsWorked: 4 },
        { nurseId, periodId: 'p1', periodStart: isoDate('2025-06-15'), weekendsWorked: 2 },
      ],
      ACTOR,
    );

    // One batch entry rather than one per row: a six-month seed for 42 nurses would
    // otherwise write hundreds of audit rows that say nothing individually.
    const imports = recentAudit(handle.db).filter(
      (e) => e.entityType === 'fairness_ledger' && e.action === 'import',
    );
    expect(imports).toHaveLength(1);
    expect(imports[0]?.after).toMatchObject({ count: 2 });
  });
});
