/**
 * The publish lifecycle: a first publication freezes what went out, a republish carries a
 * reason and a real diff, and every post-publish edit lands in the change log with its
 * reason — the M12 acceptance check "publish, edit, and confirm the change log and audit
 * entries tell the full story", at the repository layer.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, isoDate } from '@shiftnurse/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auditHistoryFor, recentAudit } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import { createShiftType, createUnit } from './config.js';
import { getFairnessLedgerEntry, upsertFairnessLedgerEntry } from './ledger.js';
import {
  changesSinceLastPublish,
  latestVersion,
  listChanges,
  listVersions,
  pendingDiff,
  publishSchedule,
  recordScheduleChange,
  requireChangeConsent,
  requireChangeReason,
  requirePeriodEditable,
} from './publish.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import {
  createAssignment,
  createPeriod,
  deleteAssignment,
  getPeriod,
  listAssignmentsForPeriod,
  moveAssignment,
} from './schedule.js';

const ACTOR = 'manager';
let handle: OpenedDatabase;
let unitId: string;
let periodId: string;
let shiftTypeId: string;
let ann: string;
let bo: string;

beforeEach(() => {
  handle = openTestDatabase();
  const db = handle.db;
  unitId = createUnit(
    db,
    {
      name: '4 West',
      unitType: 'Med-Surg',
      payPeriodDays: 14,
      payPeriodAnchor: isoDate('2026-01-04'),
    },
    ACTOR,
  ).id;
  const ruleSet = transact(db, (tx) =>
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
        configs: [],
      },
      ACTOR,
    ),
  );
  shiftTypeId = createShiftType(
    db,
    {
      unitId,
      name: 'Day 12',
      abbreviation: 'D12',
      startTime: '07:00',
      durationHours: 12,
      isNight: false,
      isOnCall: false,
      color: '#fff',
      sortOrder: 1,
      active: true,
    },
    ACTOR,
  ).id;
  const nurse = (employeeId: string, firstName: string) =>
    createNurse(
      db,
      {
        unitId,
        employeeId,
        firstName,
        lastName: 'Nurse',
        role: 'RN',
        employmentType: 'full_time',
        fte: 1,
        contractedHoursPerPeriod: 72,
        seniorityDate: isoDate('2020-01-01'),
        isChargeEligible: true,
        isNovice: false,
        isFloatEligible: true,
        active: true,
      },
      ACTOR,
    ).id;
  ann = nurse('E1', 'Ann');
  bo = nurse('E2', 'Bo');
  periodId = createPeriod(
    db,
    {
      unitId,
      name: 'PP1',
      startDate: isoDate('2026-01-04'),
      endDate: isoDate('2026-01-17'),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    },
    ACTOR,
  ).id;
  createAssignment(db, { periodId, nurseId: ann, shiftTypeId, date: isoDate('2026-01-05') }, ACTOR);
  createAssignment(db, { periodId, nurseId: bo, shiftTypeId, date: isoDate('2026-01-06') }, ACTOR);
});

describe('publishSchedule', () => {
  it('can only be called inside a transaction, so a publish is never half-written', () => {
    // Never invoked: the point is that the compiler refuses a bare handle.
    const bare = () =>
      // @ts-expect-error a bare handle is not a ShiftNurseTx
      publishSchedule(handle.db, { periodId }, ACTOR);
    expect(bare).toBeDefined();
  });

  it('freezes the assignments as version 1 and books the fairness ledger', () => {
    const result = transact(handle.db, (tx) =>
      publishSchedule(
        tx,
        {
          periodId,
          ledger: [
            {
              nurseId: ann,
              periodId,
              periodStart: isoDate('2026-01-04'),
              periodDays: 14,
              totalHours: 12,
            },
          ],
        },
        ACTOR,
      ),
    );
    expect(result.period.status).toBe('published');
    expect(result.period.publishedAt).toBeTypeOf('number');
    expect(result.version.version).toBe(1);
    expect(result.version.assignments).toHaveLength(2);
    expect(result.diff).toMatchObject({ added: 2, removed: 0, changed: 0 });
    expect(result.ledgerEntries).toBe(1);
    expect(getFairnessLedgerEntry(handle.db, ann, periodId)?.totalHours).toBe(12);
    expect(auditHistoryFor(handle.db, 'schedule_period', periodId)[0]?.action).toBe('publish');
  });

  it("drops Ann's night from the ledger when a republish gives it to Bea", () => {
    const db = handle.db;
    const periodStart = isoDate('2026-01-04');
    transact(db, (tx) =>
      publishSchedule(
        tx,
        {
          periodId,
          ledger: [{ nurseId: ann, periodId, periodStart, periodDays: 14, nightShifts: 1 }],
        },
        ACTOR,
      ),
    );
    const annsShift = listAssignmentsForPeriod(db, periodId).find((a) => a.nurseId === ann)!;
    transact(db, (tx) =>
      moveAssignment(tx, annsShift.id, { nurseId: bo, shiftTypeId, date: annsShift.date }, ACTOR),
    );
    const result = transact(db, (tx) =>
      publishSchedule(
        tx,
        {
          periodId,
          reason: 'Ann on leave',
          ledger: [{ nurseId: bo, periodId, periodStart, periodDays: 14, nightShifts: 1 }],
        },
        ACTOR,
      ),
    );
    expect(result.ledgerRemoved).toBe(1);
    expect(getFairnessLedgerEntry(db, ann, periodId)).toBeUndefined();
    expect(getFairnessLedgerEntry(db, bo, periodId)?.nightShifts).toBe(1);
    const annRow = recentAudit(db, 1000).filter(
      (e) => e.entityType === 'fairness_ledger' && e.action === 'delete',
    );
    expect(annRow).toHaveLength(1);
    expect(annRow[0]!.before).toMatchObject({ nurseId: ann, nightShifts: 1 });
    expect(annRow[0]!.reason).toContain('version 2');
  });

  it('leaves the ledger alone when a publish books none', () => {
    const db = handle.db;
    upsertFairnessLedgerEntry(
      db,
      {
        nurseId: ann,
        periodId,
        periodStart: isoDate('2026-01-04'),
        periodDays: 14,
        nightShifts: 1,
      },
      ACTOR,
    );
    const result = transact(db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    expect(result.ledgerRemoved).toBe(0);
    expect(getFairnessLedgerEntry(db, ann, periodId)?.nightShifts).toBe(1);
  });

  it('refuses to republish without a reason, and refuses when nothing changed', () => {
    transact(handle.db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    expect(() => transact(handle.db, (tx) => publishSchedule(tx, { periodId }, ACTOR))).toThrow(
      /requires a reason/,
    );
    expect(() =>
      transact(handle.db, (tx) => publishSchedule(tx, { periodId, reason: 'no-op' }, ACTOR)),
    ).toThrow(/Nothing has changed since version 1/);
  });

  it('still wants a reason to republish a schedule that breaks nothing', () => {
    transact(handle.db, (tx) =>
      publishSchedule(tx, { periodId, hardViolations: { count: 0, codes: [] } }, ACTOR),
    );
    createAssignment(
      handle.db,
      { periodId, nurseId: ann, shiftTypeId, date: isoDate('2026-01-08') },
      ACTOR,
    );
    expect(() =>
      transact(handle.db, (tx) =>
        publishSchedule(tx, { periodId, hardViolations: { count: 0, codes: [] } }, ACTOR),
      ),
    ).toThrow(/Republishing a schedule requires a reason/);
    expect(listVersions(handle.db, periodId)).toHaveLength(1);
  });

  it('records a clean schedule as zero rule breaks', () => {
    const result = transact(handle.db, (tx) =>
      publishSchedule(tx, { periodId, hardViolations: { count: 0, codes: [] } }, ACTOR),
    );
    const entry = auditHistoryFor(handle.db, 'schedule_version', result.version.id)[0]!;
    expect((entry.after as { hardViolations: unknown }).hardViolations).toEqual({
      count: 0,
      codes: [],
    });
  });

  it('refuses a first publish over rule breaks without a reason, and writes nothing', () => {
    const auditsBefore = recentAudit(handle.db, 1000).length;
    expect(() =>
      transact(handle.db, (tx) =>
        publishSchedule(
          tx,
          {
            periodId,
            ledger: [],
            hardViolations: { count: 2, codes: ['insufficient_rest', 'understaffed'] },
          },
          ACTOR,
        ),
      ),
    ).toThrow(/2 rule breaks needs a reason/);
    expect(latestVersion(handle.db, periodId)).toBeUndefined();
    expect(recentAudit(handle.db, 1000)).toHaveLength(auditsBefore);
  });

  it('records the rule breaks a schedule went out over, with the reason', () => {
    const result = transact(handle.db, (tx) =>
      publishSchedule(
        tx,
        {
          periodId,
          reason: 'Agency confirmed for the short nights',
          hardViolations: { count: 2, codes: ['insufficient_rest', 'understaffed'] },
        },
        ACTOR,
      ),
    );
    const entry = auditHistoryFor(handle.db, 'schedule_version', result.version.id)[0]!;
    expect(entry.reason).toBe('Agency confirmed for the short nights');
    expect((entry.after as { hardViolations: unknown }).hardViolations).toEqual({
      count: 2,
      codes: ['insufficient_rest', 'understaffed'],
    });
  });

  it('needs no reason for a first publish that breaks nothing', () => {
    const result = transact(handle.db, (tx) =>
      publishSchedule(tx, { periodId, hardViolations: { count: 0, codes: [] } }, ACTOR),
    );
    expect(result.version.version).toBe(1);
  });

  it('carries a post-publish move into version 2 as one removal and one addition', () => {
    const db = handle.db;
    transact(db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    const period = getPeriod(db, periodId)!;
    const reason = requireChangeReason(period, "Ann's sick note for the 5th");
    const before = listAssignmentsForPeriod(db, periodId).find((a) => a.nurseId === ann)!;
    deleteAssignment(db, before.id, ACTOR, reason);
    recordScheduleChange(
      db,
      {
        periodId,
        kind: 'removed',
        assignmentId: before.id,
        nurseId: ann,
        date: isoDate('2026-01-05'),
        shiftTypeId,
        before,
        reason: reason!,
      },
      ACTOR,
    );
    const added = createAssignment(
      db,
      { periodId, nurseId: bo, shiftTypeId, date: isoDate('2026-01-05') },
      ACTOR,
    );
    recordScheduleChange(
      db,
      {
        periodId,
        kind: 'added',
        assignmentId: added.id,
        nurseId: bo,
        date: isoDate('2026-01-05'),
        shiftTypeId,
        after: added,
        reason: reason!,
      },
      ACTOR,
    );

    expect(changesSinceLastPublish(db, periodId).map((c) => c.kind)).toEqual(['added', 'removed']);
    expect(pendingDiff(db, periodId)).toMatchObject({ added: 1, removed: 1, changed: 0 });

    const v2 = transact(db, (tx) =>
      publishSchedule(tx, { periodId, reason: 'Cover for Ann' }, ACTOR),
    );
    expect(v2.version.version).toBe(2);
    expect(v2.diff.affectedNurseIds.sort()).toEqual([ann, bo].sort());
    expect(listVersions(db, periodId).map((v) => v.version)).toEqual([1, 2]);
    expect(latestVersion(db, periodId)?.reason).toBe('Cover for Ann');
    // The edits belong to version 1; after republishing there is nothing pending.
    expect(changesSinceLastPublish(db, periodId)).toEqual([]);
    expect(listChanges(db, periodId)).toHaveLength(2);
    expect(listChanges(db, periodId).every((c) => c.version === 1)).toBe(true);
  });

  it('lists only the changes made since the last publish, whatever the clock said', () => {
    const db = handle.db;
    const day = isoDate('2026-01-05');
    const note = (kind: 'added' | 'removed', reason: string) =>
      recordScheduleChange(
        db,
        { periodId, kind, assignmentId: 'a-1', nurseId: ann, date: day, shiftTypeId, reason },
        ACTOR,
      );
    transact(db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    createAssignment(db, { periodId, nurseId: bo, shiftTypeId, date: day }, ACTOR);
    note('removed', 'Ann is sick');
    transact(db, (tx) => publishSchedule(tx, { periodId, reason: 'Cover for Ann' }, ACTOR));
    const last = note('added', 'Bo picks up the 5th');
    expect(changesSinceLastPublish(db, periodId).map((c) => c.reason)).toEqual([
      'Bo picks up the 5th',
    ]);

    // The clock stepped backwards: this v2 edit is stamped before v2 went out. Version 2 is
    // still its definition, so it is still pending.
    const publishedAt = latestVersion(db, periodId)!.publishedAt;
    // The change log refuses edits, so the clock itself steps back while the entry is written.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(publishedAt - 1);
    const early = note('added', 'Stamped before the publish');
    clock.mockRestore();
    expect(
      changesSinceLastPublish(db, periodId)
        .map((c) => c.id)
        .sort(),
    ).toEqual([last.id, early.id].sort());
  });
});

describe('the change log', () => {
  it('needs no reason on a draft but refuses a blank one once published', () => {
    const draft = getPeriod(handle.db, periodId)!;
    expect(requireChangeReason(draft)).toBeUndefined();
    transact(handle.db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    const published = getPeriod(handle.db, periodId)!;
    expect(() => requireChangeReason(published, '   ')).toThrow(/requires a reason/);
    expect(requireChangeReason(published, '  swap for clinic  ')).toBe('swap for clinic');
  });

  it("asks the nurse's consent only for the manager's own changes to a posted schedule", () => {
    const draft = getPeriod(handle.db, periodId)!;
    transact(handle.db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    const published = getPeriod(handle.db, periodId)!;
    const opted = { requireConsentForPostedChanges: true };
    const refusal =
      "This unit requires the nurse's consent to change a posted shift. Record how they agreed.";
    for (const source of ['manual', 'resolution'] as const) {
      expect(() => requireChangeConsent(published, opted, source)).toThrow(refusal);
      expect(() => requireChangeConsent(published, opted, source, '  ')).toThrow(refusal);
      expect(requireChangeConsent(published, opted, source, ' agreed by phone ')).toBe(
        'agreed by phone',
      );
    }
    // The nurses proposed it, asked for it, accepted the call, or the contract's order decides.
    for (const source of ['exchange', 'time_off', 'backfill', 'census', 'float'] as const) {
      expect(requireChangeConsent(published, opted, source)).toBeUndefined();
    }
    expect(requireChangeConsent(draft, opted, 'manual')).toBeUndefined();
    expect(requireChangeConsent(published, {}, 'manual')).toBeUndefined();
  });

  it('lets a draft or published schedule be edited but freezes an archived one', () => {
    // Locking a shift needs no reason, but it is still an edit: an archived period is the
    // record of what was worked and must not change, whatever the edit.
    expect(() => requirePeriodEditable(getPeriod(handle.db, periodId)!)).not.toThrow();
    transact(handle.db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    expect(() => requirePeriodEditable(getPeriod(handle.db, periodId)!)).not.toThrow();
    const archived = { ...getPeriod(handle.db, periodId)!, status: 'archived' as const };
    expect(() => requirePeriodEditable(archived)).toThrow(/archived/);
  });

  it('keeps how the nurse agreed to a change, and nothing when none was given', () => {
    const db = handle.db;
    transact(db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    const a = listAssignmentsForPeriod(db, periodId).find((x) => x.nurseId === ann)!;
    const base = {
      periodId,
      kind: 'removed' as const,
      assignmentId: a.id,
      nurseId: ann,
      date: isoDate('2026-01-05'),
      shiftTypeId,
      before: a,
      reason: 'Swap agreed',
    };
    const withConsent = recordScheduleChange(
      db,
      { ...base, consent: 'agreed by phone 6 Oct 14:10' },
      ACTOR,
    );
    const without = recordScheduleChange(db, base, ACTOR);
    expect(withConsent.consent).toBe('agreed by phone 6 Oct 14:10');
    expect(without.consent).toBeUndefined();
    const stored = changesSinceLastPublish(db, periodId);
    expect(stored.find((c) => c.id === withConsent.id)?.consent).toBe(
      'agreed by phone 6 Oct 14:10',
    );
  });

  it('refuses to log a change on a period that was never published', () => {
    expect(() =>
      recordScheduleChange(
        handle.db,
        {
          periodId,
          kind: 'added',
          assignmentId: 'asg_x',
          nurseId: ann,
          date: isoDate('2026-01-05'),
          shiftTypeId,
          reason: 'x',
        },
        ACTOR,
      ),
    ).toThrow(/never been published/);
  });

  it('writes a strict audit entry quoting the reason next to the change row', () => {
    transact(handle.db, (tx) => publishSchedule(tx, { periodId }, ACTOR));
    const change = recordScheduleChange(
      handle.db,
      {
        periodId,
        kind: 'changed',
        assignmentId: 'asg_x',
        nurseId: ann,
        date: isoDate('2026-01-05'),
        shiftTypeId,
        reason: 'Made charge after Bo called out',
      },
      ACTOR,
    );
    const audit = auditHistoryFor(handle.db, 'schedule_change', change.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe('Made charge after Bo called out');
  });
});
