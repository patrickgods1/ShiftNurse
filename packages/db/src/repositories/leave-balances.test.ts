/**
 * Leave balances and FMLA certifications. The balance is copied in from payroll, so what matters
 * is that setting it twice updates the one figure and audits what it was before, and that a
 * certification that runs backwards or names no real nurse is refused in words.
 */

import { isoDate } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import {
  createFmlaCertification,
  deleteFmlaCertification,
  getLeaveBalance,
  listFmlaCertifications,
  listLeaveBalancesForNurse,
  setLeaveBalance,
  updateFmlaCertification,
} from './leave-balances.js';
import { createNurse } from './roster.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let nurseId: string;

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
  nurseId = createNurse(
    handle.db,
    {
      unitId: unit.id,
      employeeId: nextEmployeeId(),
      firstName: 'Ada',
      lastName: 'Test',
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
});
afterEach(() => handle.close());

describe('a nurse’s leave balance from payroll', () => {
  it('keeps a PTO and a sick balance side by side', () => {
    setLeaveBalance(
      handle.db,
      { nurseId, type: 'pto', balanceHours: 40, asOf: isoDate('2026-10-01') },
      ACTOR,
    );
    setLeaveBalance(
      handle.db,
      { nurseId, type: 'sick', balanceHours: 24, asOf: isoDate('2026-10-01') },
      ACTOR,
    );
    expect(
      listLeaveBalancesForNurse(handle.db, nurseId).map((b) => [b.type, b.balanceHours]),
    ).toEqual([
      ['pto', 40],
      ['sick', 24],
    ]);
  });

  it('updates the one figure on a second entry and audits what it was before', () => {
    const first = setLeaveBalance(
      handle.db,
      { nurseId, type: 'pto', balanceHours: 40, asOf: isoDate('2026-10-01') },
      ACTOR,
    );
    const second = setLeaveBalance(
      handle.db,
      { nurseId, type: 'pto', balanceHours: 28, asOf: isoDate('2026-10-15') },
      ACTOR,
    );
    expect(second.id).toBe(first.id);
    expect(getLeaveBalance(handle.db, nurseId, 'pto')).toMatchObject({
      balanceHours: 28,
      asOf: '2026-10-15',
    });
    expect(auditHistoryFor(handle.db, 'leave_balance', first.id)[0]).toMatchObject({
      action: 'update',
      before: { balanceHours: 40, asOf: '2026-10-01' },
      after: { balanceHours: 28, asOf: '2026-10-15' },
    });
  });

  it('keeps annual and comp balances, as a federal unit does, and refuses anything else', () => {
    for (const type of ['annual', 'comp'] as const) {
      setLeaveBalance(
        handle.db,
        { nurseId, type, balanceHours: 96, asOf: isoDate('2026-10-01') },
        ACTOR,
      );
      expect(getLeaveBalance(handle.db, nurseId, type)?.balanceHours).toBe(96);
    }
    expect(() =>
      setLeaveBalance(
        handle.db,
        { nurseId, type: 'bereavement' as never, balanceHours: 8, asOf: isoDate('2026-10-01') },
        ACTOR,
      ),
    ).toThrow('Only PTO, annual, sick and comp balances are kept');
  });

  it('refuses a negative balance and a nurse who does not exist', () => {
    const base = { type: 'pto' as const, asOf: isoDate('2026-10-01') };
    expect(() => setLeaveBalance(handle.db, { nurseId, balanceHours: -4, ...base }, ACTOR)).toThrow(
      'A balance is zero hours or more',
    );
    expect(() =>
      setLeaveBalance(handle.db, { nurseId: 'nobody', balanceHours: 4, ...base }, ACTOR),
    ).toThrow('Nurse nobody not found');
  });
});

describe('FMLA certifications', () => {
  const cert = (start: string, end: string, intermittent = false, note?: string) =>
    createFmlaCertification(
      handle.db,
      {
        nurseId,
        startDate: isoDate(start),
        endDate: isoDate(end),
        intermittent,
        ...(note ? { note } : {}),
      },
      ACTOR,
    );

  it('records a certification with its note and audits it', () => {
    const c = cert('2026-10-01', '2027-03-31', true, ' certified by Dr. Lee ');
    expect(listFmlaCertifications(handle.db, nurseId)).toEqual([
      { ...c, note: 'certified by Dr. Lee', intermittent: true },
    ]);
    expect(auditHistoryFor(handle.db, 'fmla_certification', c.id)[0]).toMatchObject({
      action: 'create',
    });
  });

  it('refuses one that ends before it starts', () => {
    expect(() => cert('2026-10-05', '2026-10-01')).toThrow(
      'The certification ends before it starts',
    );
  });

  it('extends a certification, clears its note, and audits the before', () => {
    const c = cert('2026-10-01', '2026-12-31', false, 'Dr. Lee');
    const updated = updateFmlaCertification(
      handle.db,
      c.id,
      { endDate: isoDate('2027-03-31'), note: null },
      ACTOR,
    );
    expect(updated.endDate).toBe('2027-03-31');
    expect(updated.note).toBeUndefined();
    expect(auditHistoryFor(handle.db, 'fmla_certification', c.id)[0]).toMatchObject({
      action: 'update',
      before: { endDate: '2026-12-31', note: 'Dr. Lee' },
    });
  });

  it('refuses to hand a certification to another nurse', () => {
    const c = cert('2026-10-01', '2026-12-31');
    expect(() =>
      updateFmlaCertification(handle.db, c.id, { nurseId: 'other' } as never, ACTOR),
    ).toThrow(/FMLA certification/);
  });

  it('removes a certification and audits it with what it was', () => {
    const c = cert('2026-10-01', '2026-12-31');
    deleteFmlaCertification(handle.db, c.id, ACTOR);
    expect(listFmlaCertifications(handle.db, nurseId)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'fmla_certification', c.id)[0]).toMatchObject({
      action: 'delete',
      before: { id: c.id },
    });
  });
});
