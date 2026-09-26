/**
 * The dashboard's "on shift today" and the Today screen must agree on whose shifts count for a
 * date. Periods overlap — the next draft is often laid out before the published one ends — and
 * counting every period's rows for the date listed nurses who are only *proposed* for the shift
 * in a draft as if they were working it.
 */

import { addDays } from '@shiftnurse/core';
import { publishSchedule } from '@shiftnurse/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTOR } from './context.js';
import { onShiftOn } from './dashboard.js';
import { periodsApi, scheduleApi } from './schedule.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;

beforeEach(() => {
  f = openFixture();
});

afterEach(() => {
  f.handle.close();
});

describe("the dashboard's on-shift-today list", () => {
  it('reads the published schedule when a draft overlaps it, not the draft’s proposals', () => {
    const grid = scheduleApi(f.handle.db);
    const date = addDays(f.seeded.draftStart, 2);
    const [ann, bea] = [f.rns[0]!, f.rns[1]!];
    // The seeded draft becomes the published schedule; a second draft overlaps it.
    grid.createAssignment({
      periodId: f.seeded.draftPeriodId,
      nurseId: ann.id,
      shiftTypeId: f.day.id,
      date,
    });
    publishSchedule(f.handle.db, { periodId: f.seeded.draftPeriodId, ledger: [] }, ACTOR);
    const next = periodsApi(f.handle.db).create({
      unitId: f.seeded.unitId,
      name: 'Next draft',
      startDate: date,
      endDate: addDays(date, 13),
    });
    grid.createAssignment({ periodId: next.id, nurseId: bea.id, shiftTypeId: f.day.id, date });

    const onShift = onShiftOn(f.handle.db, f.seeded.unitId, date);
    const names = onShift.flatMap((v) => v.nurses.map((n) => n.id));
    expect(names).toEqual([ann.id]);
  });

  it('is empty on a date no period covers', () => {
    expect(onShiftOn(f.handle.db, f.seeded.unitId, addDays(f.seeded.draftStart, -400))).toEqual([]);
  });
});
