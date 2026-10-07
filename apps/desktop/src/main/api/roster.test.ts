/**
 * The roster through the IPC handlers: every write lands with its audit row, and a refusal
 * (no reason for keeping two nurses apart, an unknown nurse) reaches the caller in words and
 * leaves nothing behind. The file-dialog halves live in `api.ts`, so they are not here.
 */

import { isoDate, parseRosterCsv } from '@shiftnurse/core';
import { auditHistoryFor, createHoliday, recentAudit } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rosterApi } from './roster.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

const api = () => rosterApi(f.handle.db);
const auditsOf = (type: string, id: string) => auditHistoryFor(f.handle.db, type, id);

function newHire() {
  const { id: _id, ...ann } = f.rns[0]!;
  return {
    ...ann,
    employeeId: 'E-NEW-1',
    firstName: 'Nia',
    lastName: 'Newhire',
    phone: undefined,
    email: undefined,
    notes: undefined,
  };
}

describe('adding and changing nurses', () => {
  it('records a new hire with a create entry from the manager', () => {
    const nia = api().nurses.create(newHire());
    expect(api().nurses.get(nia.id)?.lastName).toBe('Newhire');
    expect(
      api()
        .nurses.list(f.seeded.unitId)
        .map((n) => n.id),
    ).toContain(nia.id);
    const [entry] = auditsOf('nurse', nia.id);
    expect(entry).toMatchObject({ action: 'create', actor: 'manager' });
  });

  it('keeps the old values in the audit row when a nurse’s hours change', () => {
    const ann = f.rns[0]!;
    const updated = api().nurses.update(ann.id, { contractedHoursPerPeriod: 48 });
    expect(updated.contractedHoursPerPeriod).toBe(48);
    const [entry] = auditsOf('nurse', ann.id);
    expect(entry!.action).toBe('update');
    expect(entry!.before).toMatchObject({ contractedHoursPerPeriod: ann.contractedHoursPerPeriod });
    expect(entry!.after).toMatchObject({ contractedHoursPerPeriod: 48 });
  });

  it('refuses a patch that tries to move a nurse to another unit', () => {
    const before = recentAudit(f.handle.db, 1000).length;
    expect(() => api().nurses.update(f.rns[0]!.id, { unitId: 'elsewhere' } as never)).toThrow();
    expect(api().nurses.get(f.rns[0]!.id)?.unitId).toBe(f.seeded.unitId);
    expect(recentAudit(f.handle.db, 1000)).toHaveLength(before);
  });

  it('deactivates a nurse who leaves, without deleting her', () => {
    const ann = f.rns[0]!;
    expect(api().nurses.deactivate(ann.id).active).toBe(false);
    expect(api().nurses.get(ann.id)?.active).toBe(false);
    expect(auditsOf('nurse', ann.id)[0]!.action).toBe('delete');
  });

  it('says so when asked to deactivate a nurse who is not on the roster', () => {
    expect(() => api().nurses.deactivate('nobody')).toThrow(/not found/i);
  });
});

describe('credentials and preferences', () => {
  it('grants a new certification, moves its expiry and revokes it, auditing each step', () => {
    const acls = api().credentials.create({
      code: 'TNCC',
      name: 'Trauma Nursing Core Course',
      tracksExpiry: true,
    });
    expect(
      api()
        .credentials.list()
        .map((c) => c.code),
    ).toContain('TNCC');
    const ann = f.rns[0]!;
    const granted = api().credentials.grant({
      nurseId: ann.id,
      credentialId: acls.id,
      expiresOn: isoDate('2027-01-31'),
    });
    expect(
      api()
        .credentials.forNurse(ann.id)
        .map((c) => c.id),
    ).toContain(granted.id);

    const moved = api().credentials.updateExpiry(granted.id, isoDate('2028-01-31'));
    expect(moved.expiresOn).toBe('2028-01-31');
    api().credentials.revoke(granted.id);
    expect(
      api()
        .credentials.forNurse(ann.id)
        .map((c) => c.id),
    ).not.toContain(granted.id);

    expect(auditsOf('nurse_credential', granted.id).map((a) => a.action)).toEqual([
      'delete',
      'update',
      'create',
    ]);
  });

  it('replaces a nurse’s preferences wholesale and audits the change', () => {
    const ann = f.rns[0]!;
    const saved = api().preferences.replace(ann.id, [
      { kind: 'avoid_shift_type', shiftTypeId: f.night.id, weight: 3 },
    ]);
    expect(saved).toHaveLength(1);
    expect(
      api()
        .preferences.forNurse(ann.id)
        .map((p) => p.kind),
    ).toEqual(['avoid_shift_type']);
    expect(auditsOf('preference', ann.id)[0]!.action).toBe('update');
  });

  it('keeps a nurse’s wish to work a holiday through save and reload', () => {
    const ann = f.rns[0]!;
    const christmas = createHoliday(
      f.handle.db,
      {
        unitId: f.seeded.unitId,
        date: isoDate('2032-12-25'),
        name: 'Christmas Day',
        isMajor: true,
      },
      'test',
    );
    api().preferences.replace(ann.id, [
      { kind: 'holiday_appetite', holidayId: christmas.id, weight: 4 },
    ]);
    expect(
      api()
        .preferences.forNurse(ann.id)
        .map(({ id: _id, ...p }) => p),
    ).toEqual([{ nurseId: ann.id, kind: 'holiday_appetite', holidayId: christmas.id, weight: 4 }]);
  });
});

describe('keeping two nurses apart', () => {
  const pair = () => ({
    unitId: f.seeded.unitId,
    name: 'Ann and Bea',
    nurseIds: [f.rns[0]!.id, f.rns[1]!.id],
    maxTogether: 1,
  });

  it('refuses to keep nurses apart without a reason, and writes nothing', () => {
    expect(() => api().incompatibility.create(pair(), '')).toThrow(/reason/i);
    expect(api().incompatibility.list(f.seeded.unitId)).toEqual([]);
  });

  it('creates, renames and removes a group, each with the stated reason in the audit log', () => {
    const group = api().incompatibility.create(pair(), 'Requested by HR');
    expect(api().incompatibility.list(f.seeded.unitId)).toHaveLength(1);
    api().incompatibility.update(group.id, { name: 'A and B' }, 'Renamed for the roster');
    api().incompatibility.remove(group.id, 'Resolved with HR');
    expect(api().incompatibility.list(f.seeded.unitId)).toEqual([]);

    const history = auditsOf('incompatibility_group', group.id);
    expect(history.map((a) => a.action)).toEqual(['delete', 'update', 'create']);
    expect(history.map((a) => a.reason)).toEqual([
      'Resolved with HR',
      'Renamed for the roster',
      'Requested by HR',
    ]);
  });

  it('refuses a group of one nurse in words', () => {
    expect(() =>
      api().incompatibility.create({ ...pair(), nurseIds: [f.rns[0]!.id] }, 'HR'),
    ).toThrow(/at least two/i);
  });

  it('says so when removing a group that does not exist', () => {
    expect(() => api().incompatibility.remove('gone', 'cleanup')).toThrow(/not found/i);
  });
});

describe('the roster CSV', () => {
  it('exports the roster so that importing it back updates every nurse and creates none', () => {
    const csv = api().roster.exportCsv(f.seeded.unitId);
    const parsed = parseRosterCsv(csv, { payPeriodDays: 14 });
    expect(parsed.errors).toEqual([]);
    const summary = api().roster.importRows(f.seeded.unitId, parsed.rows);
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(parsed.rows.length);
  });

  it('adds a nurse who appears only in the file, with an audit entry', () => {
    const csv = api().roster.exportCsv(f.seeded.unitId);
    const parsed = parseRosterCsv(csv, { payPeriodDays: 14 });
    const extra = structuredClone(parsed.rows[0]!);
    extra.nurse.employeeId = 'E-CSV-9';
    extra.nurse.firstName = 'Cy';
    const summary = api().roster.importRows(f.seeded.unitId, [extra]);
    expect(summary.created).toBe(1);
    const cy = api()
      .nurses.list(f.seeded.unitId)
      .find((n) => n.employeeId === 'E-CSV-9');
    expect(cy).toBeDefined();
    expect(auditsOf('nurse', cy!.id)[0]).toMatchObject({ action: 'create', actor: 'manager' });
  });
});
