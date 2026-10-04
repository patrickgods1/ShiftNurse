/**
 * The handlers that begin with a native file dialog. Electron's dialogs are stubbed (they are the
 * only Electron in these modules); what is under test is what main does with the chosen file: a
 * cancelled dialog changes nothing, a bad row is reported rather than dropped, and the roster a
 * manager exports is one she can import again.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRosterCsv } from '@shiftnurse/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dialogs = vi.hoisted(() => ({ openFile: vi.fn(), saveFile: vi.fn() }));
vi.mock('../native-dialogs.js', () => dialogs);

import { exportRosterToFile, pickHistoryImportFile, pickRosterImportFile } from './files.js';
import { rosterApi } from './roster.js';
import { type Fixture, openFixture } from './test-fixture.js';

let f: Fixture;
let dir: string;

beforeEach(() => {
  f = openFixture();
  dir = mkdtempSync(join(tmpdir(), 'shiftnurse-files-'));
  dialogs.openFile.mockReset();
  dialogs.saveFile.mockReset();
});

afterEach(() => {
  f.handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('exporting the roster', () => {
  it('writes a CSV that parses back to the same nurses', async () => {
    const target = join(dir, 'roster.csv');
    dialogs.saveFile.mockResolvedValue(target);
    const path = await exportRosterToFile(f.handle.db, f.seeded.unitId);
    expect(path).toBe(target);
    const parsed = parseRosterCsv(readFileSync(target, 'utf8'), { payPeriodDays: 14 });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(rosterApi(f.handle.db).nurses.list(f.seeded.unitId).length);
  });

  it('offers a file name from the unit and today, safe on Windows', async () => {
    dialogs.saveFile.mockResolvedValue(undefined);
    await exportRosterToFile(f.handle.db, f.seeded.unitId);
    const { defaultPath } = dialogs.saveFile.mock.calls[0]![0] as { defaultPath: string };
    expect(defaultPath).toMatch(/^[\w-]+-roster-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('writes nothing when the manager cancels the save dialog', async () => {
    dialogs.saveFile.mockResolvedValue(undefined);
    expect(await exportRosterToFile(f.handle.db, f.seeded.unitId)).toBeUndefined();
    expect(existsSync(join(dir, 'roster.csv'))).toBe(false);
  });

  it('says so when the unit does not exist, before any dialog opens', async () => {
    await expect(exportRosterToFile(f.handle.db, 'no-unit')).rejects.toThrow(/unknown unit/i);
    expect(dialogs.saveFile).not.toHaveBeenCalled();
  });
});

describe('importing a roster file', () => {
  it('previews nothing when the manager cancels the open dialog', async () => {
    dialogs.openFile.mockResolvedValue(undefined);
    expect(await pickRosterImportFile(f.handle.db, f.seeded.unitId)).toBeUndefined();
  });

  it('flags the employees already on the roster so the preview can say "update"', async () => {
    const source = join(dir, 'in.csv');
    writeFileSync(source, rosterApi(f.handle.db).roster.exportCsv(f.seeded.unitId));
    dialogs.openFile.mockResolvedValue(source);
    const preview = await pickRosterImportFile(f.handle.db, f.seeded.unitId);
    expect(preview!.path).toBe(source);
    expect(preview!.errors).toEqual([]);
    expect(preview!.existingEmployeeIds).toHaveLength(preview!.rows.length);
  });

  it('reports a file with the wrong columns instead of importing a guess', async () => {
    const source = join(dir, 'bad.csv');
    writeFileSync(source, 'name,hours\nAnn,40\n');
    dialogs.openFile.mockResolvedValue(source);
    const preview = await pickRosterImportFile(f.handle.db, f.seeded.unitId);
    expect(preview!.rows).toEqual([]);
    expect(preview!.errors.length).toBeGreaterThan(0);
  });
});

describe('importing historical schedules', () => {
  it('previews cancelled dialogs as nothing', async () => {
    dialogs.openFile.mockResolvedValue(undefined);
    expect(await pickHistoryImportFile(f.handle.db, f.seeded.unitId)).toBeUndefined();
  });

  it('groups the file into pay periods and says which would replace recorded history', async () => {
    const ann = f.rns[0]!;
    const source = join(dir, 'history.csv');
    writeFileSync(
      source,
      [
        'employee_id,date,shift',
        `${ann.employeeId},2019-03-04,${f.day.abbreviation}`,
        `${ann.employeeId},2019-03-05,${f.day.abbreviation}`,
        `${ann.employeeId},2019-03-06,${f.day.abbreviation}`,
        `GHOST-1,2019-03-04,${f.day.abbreviation}`,
      ].join('\n'),
    );
    dialogs.openFile.mockResolvedValue(source);
    const preview = await pickHistoryImportFile(f.handle.db, f.seeded.unitId);
    expect(preview!.rows).toHaveLength(3);
    // The unknown employee id is reported, not silently dropped.
    expect(preview!.errors.map((e) => e.message).join(' ')).toMatch(/GHOST-1/);
    expect(preview!.periods).toHaveLength(1);
    expect(preview!.periods[0]).toMatchObject({ shifts: 3, nurses: 1, replacesExisting: false });
  });
});
