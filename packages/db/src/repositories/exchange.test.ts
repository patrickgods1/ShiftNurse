/**
 * Repository tests for shift exchange: proposing, deciding, and — the part that must never
 * half-happen — approval swapping assignment rows atomically.
 *
 * What is easy to get quietly wrong here: a denial or an overriding approval with no reason
 * must touch nothing; approval must refuse a stale `remove` id (the assignment already gone)
 * rather than silently skip it; and approval must refuse outside a draft period, the same rule
 * `applyResolution` follows for resolutions.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit, saveRuleSet } from './config.js';
import {
  approveSwap,
  cancelSwap,
  denySwap,
  getSwap,
  listSwapsForPeriod,
  listSwapsForUnit,
  proposeSwap,
} from './exchange.js';
import { listChanges, publishSchedule } from './publish.js';
import { createNurse } from './roster.js';
import {
  createAssignment,
  createPeriod,
  deleteAssignment,
  getAssignment,
  listAssignmentsForPeriod,
  updatePeriodStatus,
} from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let periodId: string;
let shiftTypeId: string;
let nurseAId: string;
let nurseBId: string;

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

beforeEach(() => {
  handle = openTestDatabase();
  unitId = createUnit(
    handle.db,
    {
      name: '4 West',
      unitType: 'Medical-Surgical',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
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
      fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
      configs: [],
    },
    ACTOR,
  );
  shiftTypeId = createShiftType(
    handle.db,
    {
      unitId,
      name: 'Night 12',
      abbreviation: 'N12',
      startTime: '19:00',
      durationHours: 12,
      isNight: true,
      isOnCall: false,
      color: '#4c1d95',
      sortOrder: 2,
      active: true,
    },
    ACTOR,
  ).id;
  periodId = createPeriod(
    handle.db,
    {
      unitId,
      name: 'Jan A',
      startDate: isoDate('2026-01-15'),
      endDate: isoDate('2026-01-28'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
  nurseAId = mkNurse('Ada');
  nurseBId = mkNurse('Beatrice');
});

afterEach(() => handle.close());

describe('proposing and listing', () => {
  it('records a proposed trade and lists it for both the period and the unit', () => {
    const offered = createAssignment(
      handle.db,
      { periodId, nurseId: nurseAId, shiftTypeId, date: isoDate('2026-01-16') },
      ACTOR,
    );
    const requested = createAssignment(
      handle.db,
      { periodId, nurseId: nurseBId, shiftTypeId, date: isoDate('2026-01-17') },
      ACTOR,
    );

    const swap = proposeSwap(
      handle.db,
      {
        periodId,
        kind: 'trade',
        requestingNurseId: nurseAId,
        counterpartyNurseId: nurseBId,
        offeredAssignmentId: offered.id,
        requestedAssignmentId: requested.id,
        reason: 'Ada has a family event on the 16th',
      },
      ACTOR,
    );

    expect(swap.status).toBe('proposed');
    expect(swap.enteredBy).toBe('manager');
    expect(listSwapsForPeriod(handle.db, periodId).map((s) => s.id)).toEqual([swap.id]);
    expect(listSwapsForUnit(handle.db, unitId).map((s) => s.id)).toEqual([swap.id]);
    expect(listSwapsForUnit(handle.db, unitId, 'proposed').map((s) => s.id)).toEqual([swap.id]);
    expect(listSwapsForUnit(handle.db, unitId, 'approved')).toEqual([]);
    expect(getSwap(handle.db, swap.id)?.reason).toBe('Ada has a family event on the 16th');

    const entries = auditHistoryFor(handle.db, 'shift_swap', swap.id);
    expect(entries[0]?.action).toBe('create');
  });
});

describe('denySwap', () => {
  it('refuses a blank reason and writes nothing', () => {
    const offered = createAssignment(
      handle.db,
      { periodId, nurseId: nurseAId, shiftTypeId, date: isoDate('2026-01-16') },
      ACTOR,
    );
    const swap = proposeSwap(
      handle.db,
      {
        periodId,
        kind: 'giveaway',
        requestingNurseId: nurseAId,
        counterpartyNurseId: nurseBId,
        offeredAssignmentId: offered.id,
      },
      ACTOR,
    );

    expect(() => denySwap(handle.db, swap.id, ACTOR, '')).toThrow(/requires a reason/);
    expect(() => denySwap(handle.db, swap.id, ACTOR, '   ')).toThrow(/requires a reason/);
    expect(getSwap(handle.db, swap.id)?.status).toBe('proposed');
    expect(auditHistoryFor(handle.db, 'shift_swap', swap.id).map((e) => e.action)).toEqual([
      'create',
    ]);

    const denied = denySwap(handle.db, swap.id, ACTOR, 'The unit is already short that night');
    expect(denied.status).toBe('denied');
    expect(denied.decisionReason).toBe('The unit is already short that night');
  });
});

describe('cancelSwap', () => {
  it('withdraws a request that was never decided', () => {
    const offered = createAssignment(
      handle.db,
      { periodId, nurseId: nurseAId, shiftTypeId, date: isoDate('2026-01-16') },
      ACTOR,
    );
    const swap = proposeSwap(
      handle.db,
      {
        periodId,
        kind: 'giveaway',
        requestingNurseId: nurseAId,
        counterpartyNurseId: nurseBId,
        offeredAssignmentId: offered.id,
      },
      ACTOR,
    );
    const cancelled = cancelSwap(handle.db, swap.id, ACTOR, 'Ada changed her mind');
    expect(cancelled.status).toBe('cancelled');
  });
});

describe('approveSwap', () => {
  function proposeGiveaway() {
    const offered = createAssignment(
      handle.db,
      { periodId, nurseId: nurseAId, shiftTypeId, date: isoDate('2026-01-16') },
      ACTOR,
    );
    const swap = proposeSwap(
      handle.db,
      {
        periodId,
        kind: 'giveaway',
        requestingNurseId: nurseAId,
        counterpartyNurseId: nurseBId,
        offeredAssignmentId: offered.id,
      },
      ACTOR,
    );
    return { offered, swap };
  }

  it('swaps the assignment rows and the swap status atomically', () => {
    const { offered, swap } = proposeGiveaway();

    const approved = transact(handle.db, (tx) =>
      approveSwap(
        tx,
        swap.id,
        {
          remove: [offered.id],
          create: [
            {
              periodId,
              nurseId: nurseBId,
              shiftTypeId,
              date: isoDate('2026-01-16'),
              source: 'manual',
              isLocked: false,
              isCharge: false,
              isOvertime: false,
            },
          ],
        },
        ACTOR,
        { overrode: false },
      ),
    );

    expect(approved.status).toBe('approved');
    expect(approved.overrode).toBe(false);
    expect(getAssignment(handle.db, offered.id)).toBeUndefined();
    const rows = listAssignmentsForPeriod(handle.db, periodId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nurseId).toBe(nurseBId);

    const entries = auditHistoryFor(handle.db, 'shift_swap', swap.id);
    expect(entries.find((e) => e.action === 'approve')).toBeDefined();
  });

  it('refuses an override with no reason and rolls back the whole transaction', () => {
    const { offered, swap } = proposeGiveaway();

    expect(() =>
      transact(handle.db, (tx) =>
        approveSwap(
          tx,
          swap.id,
          {
            remove: [offered.id],
            create: [
              {
                periodId,
                nurseId: nurseBId,
                shiftTypeId,
                date: isoDate('2026-01-16'),
                source: 'manual',
                isLocked: false,
                isCharge: false,
                isOvertime: false,
              },
            ],
          },
          ACTOR,
          { overrode: true },
        ),
      ),
    ).toThrow(/requires a reason/);

    // Rolled back: the swap is still proposed and the original assignment still exists.
    expect(getSwap(handle.db, swap.id)?.status).toBe('proposed');
    expect(getAssignment(handle.db, offered.id)).toBeDefined();
  });

  it('accepts an override when a reason is given', () => {
    const { offered, swap } = proposeGiveaway();

    const approved = transact(handle.db, (tx) =>
      approveSwap(
        tx,
        swap.id,
        {
          remove: [offered.id],
          create: [
            {
              periodId,
              nurseId: nurseBId,
              shiftTypeId,
              date: isoDate('2026-01-16'),
              source: 'manual',
              isLocked: false,
              isCharge: false,
              isOvertime: false,
            },
          ],
        },
        ACTOR,
        { overrode: true, reason: 'Drops Ada below her fair share but she asked for it' },
      ),
    );
    expect(approved.overrode).toBe(true);
    expect(approved.decisionReason).toBe('Drops Ada below her fair share but she asked for it');
  });

  it('refuses a stale remove id rather than dropping the row silently', () => {
    const { offered, swap } = proposeGiveaway();
    // Someone else's edit removes the offered assignment before this approval lands.
    deleteAssignment(handle.db, offered.id, ACTOR, 'Removed by another edit');

    expect(() =>
      transact(handle.db, (tx) =>
        approveSwap(
          tx,
          swap.id,
          {
            remove: [offered.id],
            create: [
              {
                periodId,
                nurseId: nurseBId,
                shiftTypeId,
                date: isoDate('2026-01-16'),
                source: 'manual',
                isLocked: false,
                isCharge: false,
                isOvertime: false,
              },
            ],
          },
          ACTOR,
          { overrode: false },
        ),
      ),
    ).toThrow(/no longer exists/);
    expect(getSwap(handle.db, swap.id)?.status).toBe('proposed');
  });

  it('needs a reason on a published period and writes the moved shifts to the change log', () => {
    const { offered, swap } = proposeGiveaway();
    publishSchedule(handle.db, { periodId }, ACTOR);
    const application = {
      remove: [offered.id],
      create: [
        {
          periodId,
          nurseId: nurseBId,
          shiftTypeId,
          date: isoDate('2026-01-16'),
          source: 'manual' as const,
          isLocked: false,
          isCharge: false,
          isOvertime: false,
        },
      ],
    };

    expect(() =>
      transact(handle.db, (tx) =>
        approveSwap(tx, swap.id, application, ACTOR, { overrode: false }),
      ),
    ).toThrow(/requires a reason/);
    expect(getSwap(handle.db, swap.id)?.status).toBe('proposed');

    transact(handle.db, (tx) =>
      approveSwap(tx, swap.id, application, ACTOR, {
        overrode: false,
        reason: 'Bo covers for Ann',
      }),
    );
    const log = listChanges(handle.db, periodId);
    expect(log.map((c) => [c.kind, c.source, c.reason])).toEqual([
      ['added', 'exchange', 'Bo covers for Ann'],
      ['removed', 'exchange', 'Bo covers for Ann'],
    ]);
  });

  it('refuses to approve on an archived period', () => {
    const { offered, swap } = proposeGiveaway();
    updatePeriodStatus(handle.db, periodId, 'archived', ACTOR);

    expect(() =>
      transact(handle.db, (tx) =>
        approveSwap(
          tx,
          swap.id,
          {
            remove: [offered.id],
            create: [
              {
                periodId,
                nurseId: nurseBId,
                shiftTypeId,
                date: isoDate('2026-01-16'),
                source: 'manual',
                isLocked: false,
                isCharge: false,
                isOvertime: false,
              },
            ],
          },
          ACTOR,
          { overrode: false },
        ),
      ),
    ).toThrow(/archived/);
  });
});
