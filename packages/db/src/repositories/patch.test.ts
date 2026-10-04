/** Tests for the key guards every repository uses on payloads that arrive over IPC. */

import { type Id, isoDate, type PayRate } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase } from '../client.js';
import { toPayRate } from '../mappers.js';
import { payRate } from '../schema.js';
import { assertKeys, auditedUpdate, type PatchKeys } from './patch.js';
import { createPayRate } from './pay.js';

describe('assertKeys', () => {
  type Policy = { enabled: boolean; limit?: number };
  const allowed = { enabled: true, limit: true } as const;

  it('accepts an object that carries only the fields its type has', () => {
    expect(() => assertKeys<Policy>({ enabled: true }, allowed, 'policy')).not.toThrow();
    expect(() => assertKeys<Policy>({ enabled: true, limit: 3 }, allowed, 'policy')).not.toThrow();
  });

  it('names the stray field it refuses', () => {
    expect(() =>
      assertKeys<Policy>({ enabled: true, unitId: 'x' } as Policy, allowed, 'policy'),
    ).toThrow("A policy cannot include 'unitId'");
  });
});

describe('auditedUpdate', () => {
  type Patch = { hourlyRate?: number };
  const allowed: PatchKeys<Patch> = { hourlyRate: true };
  let handle: OpenedDatabase;
  let rateId: Id;

  beforeEach(() => {
    handle = openTestDatabase();
    rateId = createPayRate(
      handle.db,
      { nurseId: null, role: 'RN', hourlyRate: 40, effectiveFrom: isoDate('2026-01-01') },
      'manager',
    ).id;
  });
  afterEach(() => handle.close());

  function update(id: Id, patch: Patch, validate?: (v: Patch) => void): PayRate {
    const { db } = handle;
    return auditedUpdate<PayRate, Patch>(db, {
      id,
      entityType: 'pay_rate',
      entityLabel: 'pay rate',
      allowed,
      patch,
      read: (rowId) => {
        const row = db.select().from(payRate).where(eq(payRate.id, rowId)).get();
        return row ? toPayRate(row) : undefined;
      },
      write: (rowId, values) => db.update(payRate).set(values).where(eq(payRate.id, rowId)).run(),
      notFound: `Pay rate ${id} not found`,
      validate,
      actor: 'manager',
    });
  }

  it('writes the new rate and one audit row holding the rate before and after', () => {
    const after = update(rateId, { hourlyRate: 45 });
    expect(after.hourlyRate).toBe(45);
    const updates = auditHistoryFor(handle.db, 'pay_rate', rateId).filter(
      (e) => e.action === 'update',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.before).toMatchObject({ hourlyRate: 40 });
    expect(updates[0]?.after).toMatchObject({ hourlyRate: 45 });
  });

  it('refuses a key the patch type does not carry and leaves the rate alone', () => {
    expect(() => update(rateId, { role: 'LVN' } as Patch)).toThrow(
      "A pay rate update cannot change 'role'",
    );
    const row = handle.db.select().from(payRate).where(eq(payRate.id, rateId)).get();
    expect(row?.role).toBe('RN');
    expect(
      auditHistoryFor(handle.db, 'pay_rate', rateId).filter((e) => e.action === 'update'),
    ).toEqual([]);
  });

  it('says the rate is missing when the id is unknown', () => {
    expect(() => update('nope', { hourlyRate: 45 })).toThrow('Pay rate nope not found');
  });

  it('writes nothing when the check refuses the change', () => {
    expect(() =>
      update(rateId, { hourlyRate: -1 }, () => {
        throw new Error('No negative rates');
      }),
    ).toThrow('No negative rates');
    const row = handle.db.select().from(payRate).where(eq(payRate.id, rateId)).get();
    expect(row?.hourlyRate).toBe(40);
    expect(
      auditHistoryFor(handle.db, 'pay_rate', rateId).filter((e) => e.action === 'update'),
    ).toEqual([]);
  });
});
