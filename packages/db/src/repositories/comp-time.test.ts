/**
 * Comp-time elections: the advance agreement that makes comp time lawful. Each write is audited
 * with the nurse named in the snapshot, and an election that overlaps another of hers, or ends
 * before it starts, is refused in words.
 */

import { DEFAULT_FAIRNESS_WEIGHTS, DEFAULT_WEEKEND, isoDate, type Nurse } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditHistoryFor } from '../audit.js';
import { type OpenedDatabase, openTestDatabase, transact } from '../client.js';
import {
  createCompTimeElection,
  deleteCompTimeElection,
  listCompTimeCreditsForNurse,
  listCompTimeCreditsForPeriod,
  listCompTimeElectionsForNurse,
  listCompTimeElectionsForUnit,
  recordCompTimeCredits,
  updateCompTimeElection,
} from './comp-time.js';
import { createUnit } from './config.js';
import { nextEmployeeId } from './employee-ids.test-support.js';
import { createNurse } from './roster.js';
import { saveRuleSet } from './rulesets.js';
import { createPeriod } from './schedule.js';

const ACTOR = 'manager';
const d = isoDate;
let handle: OpenedDatabase;
let unitId: string;
let vera: Nurse;
let nina: Nurse;
let stranger: Nurse;

function mkUnit(name: string) {
  return createUnit(
    handle.db,
    { name, unitType: 'Medical-Surgical', payPeriodDays: 14, payPeriodAnchor: d('2026-01-04') },
    ACTOR,
  );
}

function mkNurse(forUnit: string, firstName: string, lastName = 'Test'): Nurse {
  return createNurse(
    handle.db,
    {
      unitId: forUnit,
      employeeId: nextEmployeeId(),
      firstName,
      lastName,
      role: 'RN',
      employmentType: 'full_time',
      fte: 1,
      contractedHoursPerPeriod: 72,
      seniorityDate: d('2020-01-01'),
      isChargeEligible: false,
      isNovice: false,
      isFloatEligible: true,
      active: true,
    },
    ACTOR,
  );
}

beforeEach(() => {
  handle = openTestDatabase();
  unitId = mkUnit('4 West').id;
  vera = mkNurse(unitId, 'Vera', 'Lopez');
  nina = mkNurse(unitId, 'Nina');
  stranger = mkNurse(mkUnit('Other').id, 'Zed');
});
afterEach(() => handle.close());

const elect = (nurse: Nurse, startsOn: string, endsOn?: string, note?: string) =>
  createCompTimeElection(
    handle.db,
    {
      unitId,
      nurseId: nurse.id,
      startsOn: d(startsOn),
      ...(endsOn ? { endsOn: d(endsOn) } : {}),
      ...(note ? { note } : {}),
    },
    ACTOR,
  );

describe('recording a comp-time election', () => {
  it('stores it, lists it by start and audits the creation with the nurse named', () => {
    const later = elect(vera, '2026-06-01');
    const first = elect(vera, '2026-01-01', '2026-03-31', '  Signed 12 Dec  ');
    expect(first.note).toBe('Signed 12 Dec');
    expect(first.enteredBy).toBe('manager');
    expect(listCompTimeElectionsForNurse(handle.db, vera.id)).toEqual([first, later]);
    expect(listCompTimeElectionsForUnit(handle.db, unitId)).toEqual([first, later]);
    expect(auditHistoryFor(handle.db, 'comp_time_election', first.id)[0]).toMatchObject({
      action: 'create',
      after: { nurseId: vera.id, startsOn: '2026-01-01', endsOn: '2026-03-31' },
    });
  });

  it('refuses an election that ends before it starts', () => {
    expect(() => elect(vera, '2026-03-10', '2026-03-09')).toThrow(/ends before it starts/);
    expect(listCompTimeElectionsForNurse(handle.db, vera.id)).toEqual([]);
  });

  it('refuses one that overlaps her other election and names the date', () => {
    elect(vera, '2026-01-01', '2026-03-31');
    expect(() => elect(vera, '2026-03-31', '2026-05-01')).toThrow(
      /Vera Lopez already has a comp-time election covering .*31/,
    );
    expect(() => elect(vera, '2025-12-01', '2026-01-01')).toThrow(/already has a comp-time/);
  });

  it('treats an open-ended election as running on for ever', () => {
    elect(vera, '2026-01-01');
    expect(() => elect(vera, '2030-01-01', '2030-02-01')).toThrow(/already has a comp-time/);
  });

  it('lets the day after one ends start the next, and another nurse overlap freely', () => {
    elect(vera, '2026-01-01', '2026-03-31');
    expect(() => elect(vera, '2026-04-01')).not.toThrow();
    expect(() => elect(nina, '2026-01-01', '2026-03-31')).not.toThrow();
  });

  it('refuses a nurse who does not work on the unit', () => {
    expect(() => elect(stranger, '2026-01-01')).toThrow(/not on 4 West's roster/);
  });
});

describe('changing a comp-time election', () => {
  it('audits an update with the before, and can reopen the end and clear the note', () => {
    const e = elect(vera, '2026-01-01', '2026-03-31', 'Signed');
    const after = updateCompTimeElection(handle.db, e.id, { endsOn: null, note: null }, ACTOR);
    expect(after).toEqual({
      id: e.id,
      unitId,
      nurseId: vera.id,
      startsOn: '2026-01-01',
      enteredBy: 'manager',
    });
    expect(auditHistoryFor(handle.db, 'comp_time_election', e.id)[0]).toMatchObject({
      action: 'update',
      before: { endsOn: '2026-03-31', note: 'Signed', nurseId: vera.id },
      after: { nurseId: vera.id },
    });
  });

  it('does not count an election as overlapping itself, but refuses growing into the next', () => {
    const a = elect(vera, '2026-01-01', '2026-03-31');
    elect(vera, '2026-06-01', '2026-06-30');
    expect(() =>
      updateCompTimeElection(handle.db, a.id, { endsOn: d('2026-04-30') }, ACTOR),
    ).not.toThrow();
    expect(() =>
      updateCompTimeElection(handle.db, a.id, { endsOn: d('2026-06-01') }, ACTOR),
    ).toThrow(/already has a comp-time/);
  });

  it('refuses to move the nurse or the unit', () => {
    const e = elect(vera, '2026-01-01');
    expect(() =>
      updateCompTimeElection(handle.db, e.id, { nurseId: nina.id } as never, ACTOR),
    ).toThrow(/cannot change 'nurseId'/);
  });

  it('audits a removal with the before', () => {
    const e = elect(vera, '2026-01-01');
    deleteCompTimeElection(handle.db, e.id, ACTOR);
    expect(listCompTimeElectionsForNurse(handle.db, vera.id)).toEqual([]);
    expect(auditHistoryFor(handle.db, 'comp_time_election', e.id)[0]).toMatchObject({
      action: 'delete',
      before: { nurseId: vera.id, startsOn: '2026-01-01' },
    });
  });
});

describe('banking a period’s comp time', () => {
  const mkPeriod = (startDate: string, endDate: string) => {
    const rules = transact(handle.db, (tx) =>
      saveRuleSet(
        tx,
        {
          unitId,
          name: 'Default',
          weekendDefinition: DEFAULT_WEEKEND,
          fairnessWeights: DEFAULT_FAIRNESS_WEIGHTS,
          configs: [],
        },
        ACTOR,
      ),
    );
    return createPeriod(
      handle.db,
      {
        unitId,
        name: `${startDate} to ${endDate}`,
        startDate: d(startDate),
        endDate: d(endDate),
        ruleSetId: rules.id,
        ruleSetVersion: rules.version,
      },
      ACTOR,
    ).id;
  };

  it('banks each nurse’s credit dated on the period’s last day, with the nurse in the audit', () => {
    const periodId = mkPeriod('2026-03-01', '2026-03-14');
    const [veras, ninas] = transact(handle.db, (tx) =>
      recordCompTimeCredits(
        tx,
        periodId,
        [
          { nurseId: vera.id, overtimeHours: 4, creditedHours: 6, paidOvertimeHours: 0 },
          { nurseId: nina.id, overtimeHours: 2, creditedHours: 1.5, paidOvertimeHours: 1 },
        ],
        ACTOR,
      ),
    );
    expect(veras).toMatchObject({ periodEndDate: '2026-03-14', creditedHours: 6 });
    // Ordered by nurse id within a period, which is random here.
    const banked = listCompTimeCreditsForPeriod(handle.db, periodId);
    expect(banked).toHaveLength(2);
    expect(banked).toEqual(expect.arrayContaining([veras, ninas]));
    expect(listCompTimeCreditsForNurse(handle.db, nina.id)).toEqual([ninas]);
    expect(auditHistoryFor(handle.db, 'comp_time_credit', veras!.id)[0]).toMatchObject({
      action: 'create',
      after: { nurseId: vera.id, periodId, creditedHours: 6 },
    });
  });

  it('refuses to bank the same period twice, and writes nothing the second time', () => {
    const periodId = mkPeriod('2026-03-01', '2026-03-14');
    const once = () =>
      transact(handle.db, (tx) =>
        recordCompTimeCredits(
          tx,
          periodId,
          [{ nurseId: vera.id, overtimeHours: 4, creditedHours: 6, paidOvertimeHours: 0 }],
          ACTOR,
        ),
      );
    once();
    expect(once).toThrow(
      /^Comp time for this period was already banked on \w{3} \w{3} \d+, \d{4}\.$/,
    );
    expect(listCompTimeCreditsForPeriod(handle.db, periodId)).toHaveLength(1);
  });
});
