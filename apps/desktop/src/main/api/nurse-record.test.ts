/**
 * A nurse's record as the file says it: what was done about them, by whom, when and why, with
 * nothing about colleagues and nothing from a kept-apart group. The CSV is read back through
 * core's parser, so what is asserted is what a spreadsheet would show.
 */

import { isoDate, type Nurse } from '@shiftnurse/core';
import {
  createIncompatibilityGroup,
  createTimeOffRequest,
  denyTimeOff,
  transact,
} from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEPT_APART_NOTE } from '../nurse-record-sheet.js';
import { nurseRecordDocument } from './nurse-record.js';
import { scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = openFixture();
});
afterEach(() => f.handle.close());

/** A spreadsheet's reading of a CSV: quoted fields, doubled quotes, and the `'` guard removed. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field.replace(/^'(?=[=+\-@\t\r])/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  return rows;
}

const now = new Date();
const TODAY = isoDate(
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
);
const document = (nurse: Nurse) =>
  nurseRecordDocument(f.handle.db, nurse.id, TODAY, TODAY, isoDate('2026-10-05'));
const rowsOf = (nurse: Nurse) => parseCsv(document(nurse).csv).slice(1);

function placeShift(nurse: Nurse) {
  return scheduleApi(f.handle.db).createAssignment({
    periodId: f.seeded.draftPeriodId,
    nurseId: nurse.id,
    shiftTypeId: f.day.id,
    date: f.seeded.draftStart,
  });
}

describe('a nurse’s record as a CSV', () => {
  it('lists the shift placed and the leave denied, each with who did it and the reason given', () => {
    const [ana, bea] = f.rns as [Nurse, Nurse];
    placeShift(ana);
    placeShift(bea);
    const request = createTimeOffRequest(
      f.handle.db,
      {
        nurseId: ana.id,
        startDate: isoDate('2026-11-02'),
        endDate: isoDate('2026-11-04'),
        type: 'pto',
      },
      'manager',
    );
    denyTimeOff(f.handle.db, request.id, 'manager', 'Two nurses already off that week');
    const rows = rowsOf(ana);
    // Found by its own dates: \`ana\` is whichever RN sorts first by a random id, and the seeded
    // history may already hold a denial of hers, which as the older entry would come first.
    const denial = rows.find(
      (r) => r[4] === 'Time-off request' && r[5] === 'deny' && r[7] === '2026-11-02 to 2026-11-04',
    );
    expect(denial).toMatchObject({
      0: `${ana.firstName} ${ana.lastName}`,
      1: ana.employeeId,
      2: 'audit entry',
      6: 'manager',
      7: '2026-11-02 to 2026-11-04',
      8: 'Two nurses already off that week',
    });
    expect(denial![3]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(rows.some((r) => r[4] === 'Shift' && r[5] === 'create')).toBe(true);
    // Nothing about the colleague who also got a shift.
    expect(document(ana).csv).not.toContain(`${bea.firstName} ${bea.lastName}`);
    expect(rows.every((r) => r[1] === ana.employeeId)).toBe(true);
  });

  it('puts the oldest entry first', () => {
    const ana = f.rns[0]!;
    const first = placeShift(ana);
    scheduleApi(f.handle.db).deleteAssignment(first.id);
    const actions = rowsOf(ana)
      // The seeded history was audited today too; this shift is the one on the draft's first day.
      .filter((r) => r[4] === 'Shift' && r[7] === f.seeded.draftStart)
      .map((r) => r[5]);
    expect(actions).toEqual(['create', 'delete']);
  });

  it('keeps a stated reason from running as a spreadsheet formula', () => {
    const ana = f.rns[0]!;
    const request = createTimeOffRequest(
      f.handle.db,
      {
        nurseId: ana.id,
        startDate: isoDate('2026-11-02'),
        endDate: isoDate('2026-11-02'),
        type: 'pto',
      },
      'manager',
    );
    denyTimeOff(f.handle.db, request.id, 'manager', '=HYPERLINK("http://example.com")');
    expect(document(ana).csv).toContain(`'=HYPERLINK`);
    expect(rowsOf(ana).some((r) => r[8] === '=HYPERLINK("http://example.com")')).toBe(true);
  });
});

describe('what a record never says', () => {
  it('leaves out a kept-apart group and its reason, and says so at the foot of the file', () => {
    const [ana, bea] = f.rns as [Nurse, Nurse];
    transact(f.handle.db, (tx) =>
      createIncompatibilityGroup(
        tx,
        { unitId: f.seeded.unitId, name: 'Day pair', nurseIds: [ana.id, bea.id], maxTogether: 1 },
        'Open HR case 41 between these two',
        'manager',
      ),
    );
    const doc = document(ana);
    expect(doc.csv).not.toContain('HR case 41');
    expect(doc.html).not.toContain('HR case 41');
    expect(doc.csv).not.toContain('Day pair');
    const rows = parseCsv(doc.csv);
    expect(rows.at(-1)).toEqual([
      `${ana.firstName} ${ana.lastName}`,
      ana.employeeId,
      'note',
      '',
      '',
      '',
      '',
      '',
      KEPT_APART_NOTE,
    ]);
  });
});

describe('the printed record', () => {
  it('names the nurse, the dates and the unit, and when ShiftNurse generated it', () => {
    const ana = f.rns[0]!;
    const { html } = document(ana);
    expect(html).toContain(`Record of ${ana.firstName} ${ana.lastName}`);
    expect(html).toContain(`${TODAY} to ${TODAY}`);
    expect(html).toContain('Test scenarios: 4 West Med-Surg');
    expect(html).toContain('Generated 2026-10-05 by ShiftNurse');
    expect(html).toContain('never included in this record');
  });

  it('escapes a reason so it cannot add markup to the page', () => {
    const ana = f.rns[0]!;
    const request = createTimeOffRequest(
      f.handle.db,
      {
        nurseId: ana.id,
        startDate: isoDate('2026-11-02'),
        endDate: isoDate('2026-11-02'),
        type: 'pto',
      },
      'manager',
    );
    denyTimeOff(f.handle.db, request.id, 'manager', '<script>alert(1)</script>');
    const { html } = document(ana);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
