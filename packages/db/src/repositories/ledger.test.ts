/**
 * Repository tests for the fairness ledger: publish-time rows and the historical import that
 * replaces, never duplicates, a period already on record.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, isoDate, today } from '@shiftnurse/core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recentAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import * as s from '../schema.js';
import { createShiftType, createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import {
  getFairnessLedgerEntry,
  importFairnessLedgerEntries,
  importHistoricalLedger,
  ledgerPeriodsForUnit,
  ledgerSince,
  upsertFairnessLedgerEntry,
} from './ledger.js';
import { nurseRecord } from './nurse-record.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createPeriod } from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let _shiftTypeId: string;
let periodId: string;

function mkNurse(firstName: string): string {
  return createNurse(
    handle.db,
    {
      unitId,
      employeeId: nextEmployeeId(),
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
  _shiftTypeId = createShiftType(
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
  const ruleSet = transact(handle.db, (tx) =>
    saveRuleSet(
      tx,
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
        configs: [
          {
            ruleId: 'min-rest-between-shifts',
            enabled: true,
            params: { minRestHours: 10, onCallCountsAsWork: false },
          },
        ],
      },
      ACTOR,
    ),
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
    transact(handle.db, (tx) =>
      importFairnessLedgerEntries(
        tx,
        [
          { nurseId, periodId: 'old', periodStart: isoDate('2025-06-01'), nightShifts: 9 },
          { nurseId, periodId: 'recent', periodStart: isoDate('2025-12-01'), nightShifts: 2 },
          { nurseId, periodId: 'boundary', periodStart: isoDate('2025-10-01'), nightShifts: 4 },
        ],
        ACTOR,
      ),
    );

    const window = ledgerSince(handle.db, unitId, isoDate('2025-10-01'));
    expect(window.map((e) => e.periodId).sort()).toEqual(['boundary', 'recent']);
  });

  it('records historical seeding as an import in the audit log', () => {
    const nurseId = mkNurse('Imported');
    transact(handle.db, (tx) =>
      importFairnessLedgerEntries(
        tx,
        [
          { nurseId, periodId: 'p0', periodStart: isoDate('2025-06-01'), weekendsWorked: 4 },
          { nurseId, periodId: 'p1', periodStart: isoDate('2025-06-15'), weekendsWorked: 2 },
        ],
        ACTOR,
      ),
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

describe('historical schedule import', () => {
  it('re-importing the same period replaces the rows rather than duplicating them', () => {
    const nurseId = mkNurse('Reimported');
    const first = transact(handle.db, (tx) =>
      importHistoricalLedger(
        tx,
        unitId,
        [
          {
            nurseId,
            periodId: 'import:2025-06-01',
            periodStart: isoDate('2025-06-01'),
            nightShifts: 3,
          },
        ],
        ACTOR,
      ),
    );
    // The manager fixed a typo in the spreadsheet and ran it again.
    const second = transact(handle.db, (tx) =>
      importHistoricalLedger(
        tx,
        unitId,
        [
          {
            nurseId,
            periodId: 'import:2025-06-01',
            periodStart: isoDate('2025-06-01'),
            nightShifts: 4,
          },
        ],
        ACTOR,
      ),
    );

    expect(first).toEqual({ written: 1, replaced: 0 });
    expect(second).toEqual({ written: 1, replaced: 1 });
    expect(handle.db.select().from(s.fairnessLedger).all()).toHaveLength(1);
    expect(getFairnessLedgerEntry(handle.db, nurseId, 'import:2025-06-01')?.nightShifts).toBe(4);
  });

  it('leaves periods the new file does not mention untouched', () => {
    const nurseId = mkNurse('Partial');
    transact(handle.db, (tx) =>
      importHistoricalLedger(
        tx,
        unitId,
        [
          { nurseId, periodId: 'import:2025-06-01', periodStart: isoDate('2025-06-01') },
          { nurseId, periodId: 'import:2025-06-15', periodStart: isoDate('2025-06-15') },
        ],
        ACTOR,
      ),
    );
    transact(handle.db, (tx) =>
      importHistoricalLedger(
        tx,
        unitId,
        [{ nurseId, periodId: 'import:2025-06-15', periodStart: isoDate('2025-06-15') }],
        ACTOR,
      ),
    );
    expect(ledgerPeriodsForUnit(handle.db, unitId).map((p) => p.periodId)).toEqual([
      'import:2025-06-01',
      'import:2025-06-15',
    ]);
  });

  function mkUnit(name: string): string {
    return createUnit(
      handle.db,
      { name, unitType: 'ICU', payPeriodDays: 14, payPeriodAnchor: isoDate('2026-01-04') },
      ACTOR,
    ).id;
  }

  function mkNurseOn(unit: string, firstName: string, employeeId: string): string {
    return createNurse(
      handle.db,
      {
        unitId: unit,
        employeeId,
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

  const JUNE = { periodId: 'import:2025-06-01', periodStart: isoDate('2025-06-01') };

  it('refuses a nurse from another unit before writing anything', () => {
    const stranger = mkNurseOn(mkUnit('5 East'), 'Else', 'X1');
    const local = mkNurse('Local');
    transact(handle.db, (tx) =>
      importHistoricalLedger(tx, unitId, [{ nurseId: local, ...JUNE, nightShifts: 6 }], ACTOR),
    );
    transact(handle.db, (tx) => {
      expect(() =>
        importHistoricalLedger(
          tx,
          unitId,
          [
            { nurseId: local, ...JUNE },
            { nurseId: stranger, ...JUNE },
          ],
          ACTOR,
        ),
      ).toThrow(/not a nurse on unit/);
      // Still inside the transaction, before any rollback: nothing was deleted or written.
      expect(getFairnessLedgerEntry(tx, local, JUNE.periodId)?.nightShifts).toBe(6);
      expect(
        tx.select().from(s.auditLog).where(eq(s.auditLog.action, 'import')).all(),
      ).toHaveLength(1);
    });
  });

  it('records the import once in the audit log with what it replaced', () => {
    const nurseId = mkNurse('Audited');
    transact(handle.db, (tx) =>
      importHistoricalLedger(tx, unitId, [{ nurseId, ...JUNE, nightShifts: 6 }], ACTOR),
    );
    transact(handle.db, (tx) =>
      importHistoricalLedger(tx, unitId, [{ nurseId, ...JUNE, nightShifts: 4 }], ACTOR),
    );
    const imports = recentAudit(handle.db).filter(
      (e) => e.entityType === 'fairness_ledger' && e.action === 'import',
    );
    expect(imports).toHaveLength(2);
    const before = imports[0]?.before as { replaced: number; replacedRows: unknown[] };
    const after = imports[0]?.after as { written: number; writtenRows: { nightShifts: number }[] };
    expect(before.replaced).toBe(1);
    expect(after.written).toBe(1);
    expect(before.replacedRows).toHaveLength(1);
    expect(before.replacedRows[0]).toMatchObject({
      nurseId,
      periodId: 'import:2025-06-01',
      nightShifts: 6,
    });
    expect(after.writtenRows[0]?.nightShifts).toBe(4);
  });

  it("leaves another unit's history for the same pay period untouched", () => {
    const eastId = mkUnit('5 East');
    const bo = mkNurseOn(eastId, 'Bo', 'B1');
    transact(handle.db, (tx) =>
      importHistoricalLedger(tx, eastId, [{ nurseId: bo, ...JUNE, nightShifts: 5 }], ACTOR),
    );
    const ana = mkNurse('Ana');
    const result = transact(handle.db, (tx) =>
      importHistoricalLedger(tx, unitId, [{ nurseId: ana, ...JUNE, nightShifts: 2 }], ACTOR),
    );
    expect(result.replaced).toBe(0);
    expect(getFairnessLedgerEntry(handle.db, bo, JUNE.periodId)?.nightShifts).toBe(5);
  });

  it('puts a re-import in the record of every nurse whose numbers it replaced', () => {
    const ana = mkNurse('Ana');
    const cy = mkNurse('Cy');
    const bo = mkNurseOn(mkUnit('5 East'), 'Bo', 'B1');
    const JUNE15 = { periodId: 'import:2025-06-15', periodStart: isoDate('2025-06-15') };
    const batch = (nightShifts: number) =>
      [JUNE15, JUNE, JUNE15, JUNE].map((p, i) => ({
        nurseId: i < 2 ? ana : cy,
        ...p,
        nightShifts,
      }));
    for (const nightShifts of [6, 4]) {
      transact(handle.db, (tx) => importHistoricalLedger(tx, unitId, batch(nightShifts), ACTOR));
    }
    const day = today();
    const imports = (id: string) =>
      nurseRecord(handle.db, id, day, day).audit.filter(
        (e) => e.entityType === 'fairness_ledger' && e.action === 'import',
      );
    expect(imports(ana)).toHaveLength(2);
    expect(imports(cy)).toHaveLength(2);
    expect(imports(bo)).toHaveLength(0);

    // Oldest period first; within a period, the two nurses in id order.
    const [first, second] = [ana, cy].sort();
    const latest = recentAudit(handle.db).filter(
      (e) => e.entityType === 'fairness_ledger' && e.action === 'import',
    )[0];
    const rows = (latest!.before as { replacedRows: { periodId: string; nurseId: string }[] })
      .replacedRows;
    expect(rows.map((r) => [r.periodId, r.nurseId])).toEqual([
      ['import:2025-06-01', first],
      ['import:2025-06-01', second],
      ['import:2025-06-15', first],
      ['import:2025-06-15', second],
    ]);
  });
});
