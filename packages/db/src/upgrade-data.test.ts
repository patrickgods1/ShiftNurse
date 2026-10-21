/**
 * Data an older release could have stored, and what each upgrade migration does with it. A
 * migration that deletes or rewrites rows in a manager's file must keep exactly what the app
 * was already reading and say, in the audit log, what it changed; these tests open a file as
 * the older release left it, put the bad rows in with raw SQL, and run the upgrade.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CoverageRequirement,
  coverageFloorFor,
  type Id,
  type IsoDate,
  isoDate,
} from '@shiftnurse/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, migrationsFolder, openDatabase } from './client.js';

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

const FULL = migrationsFolder();
const journal = JSON.parse(readFileSync(join(FULL, 'meta', '_journal.json'), 'utf8')) as Journal;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shiftnurse-upgrade-data-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The migrations folder as the release before `tagSuffix` shipped it. */
function releaseBefore(tagSuffix: string): string {
  const folder = join(dir, 'older');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const cut = journal.entries.findIndex((e) => e.tag.endsWith(tagSuffix));
  if (cut < 0) throw new Error(`No migration tagged ...${tagSuffix}`);
  const entries = journal.entries.slice(0, cut);
  for (const e of entries) copyFileSync(join(FULL, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  return folder;
}

/** Open a file as the release before `tagSuffix` left it. */
function olderFile(tagSuffix: string) {
  const folder = releaseBefore(tagSuffix);
  const opened = openDatabase({
    url: join(dir, 'old.db'),
    migrationsFolder: folder,
  });
  return { opened };
}

describe('coverage floors from before they had a key', () => {
  it('keeps the coverage floor the schedule was already using, and records what the upgrade removed', () => {
    const { opened } = olderFile('_coverage_floor_keys');
    const { sqlite } = opened;
    // Raw inserts name only the columns they need; the schema's defaults fill the rest.
    insertRow(sqlite, 'unit', { id: 'u1', name: '4 West' });
    insertRow(sqlite, 'shift_type', {
      id: 's1',
      unit_id: 'u1',
      name: 'Day 12',
      abbreviation: 'D',
      start_time: '07:00',
      duration_hours: 12,
      color: '#ffffff',
      sort_order: 1,
    });
    const floor = (
      id: string,
      weekday: number | null,
      date: string | null,
      min: number,
      t: number,
    ) =>
      insertRow(sqlite, 'coverage_requirement', {
        id,
        unit_id: 'u1',
        shift_type_id: 's1',
        weekday,
        date,
        role: 'RN',
        min_count: min,
        target_count: t,
      });
    floor('A', 1, null, 3, 3);
    floor('B', 1, null, 5, 4);
    floor('C', null, null, 2, 2);
    floor('D', 5, '2026-12-25', 4, 4);

    const read = (): CoverageRequirement[] =>
      (
        sqlite.prepare('SELECT * FROM coverage_requirement ORDER BY rowid').all() as Record<
          string,
          unknown
        >[]
      ).map((r) => ({
        id: r.id as Id,
        unitId: r.unit_id as Id,
        shiftTypeId: r.shift_type_id as Id,
        weekday: r.weekday as CoverageRequirement['weekday'],
        date: r.date as IsoDate | null,
        role: 'RN',
        minCount: r.min_count as number,
        targetCount: r.target_count as number,
      }));
    const monday = isoDate('2026-12-21');
    const christmas = isoDate('2026-12-25');
    const floorsOn = (rows: CoverageRequirement[]) => [
      coverageFloorFor(rows, monday, 's1' as Id, 'RN'),
      coverageFloorFor(rows, christmas, 's1' as Id, 'RN'),
    ];
    const before = floorsOn(read());
    // By hand: Monday is read from B, the later row: min 5, target max(4, 5) = 5. Christmas is
    // D's date match.
    expect(before).toEqual([
      { min: 5, target: 5 },
      { min: 4, target: 4 },
    ]);

    migrateDatabase(opened.db, FULL);

    const rows = read();
    expect(rows.map((r) => r.id)).toEqual(['B', 'D']);
    expect(rows[0]).toMatchObject({ minCount: 5, targetCount: 5 });
    expect(rows[1]).toMatchObject({ weekday: null, date: '2026-12-25' });
    expect(floorsOn(rows)).toEqual(before);

    const audits = (
      sqlite
        .prepare(
          `SELECT entity_id, action, before, after, reason FROM audit_log
           WHERE actor = 'upgrade' AND entity_type = 'coverage_requirement'`,
        )
        .all() as {
        entity_id: string;
        action: string;
        before: string;
        after: string | null;
        reason: string;
      }[]
    ).map((a) => ({
      id: a.entity_id,
      action: a.action,
      before: JSON.parse(a.before) as Record<string, unknown>,
      after: a.after ? (JSON.parse(a.after) as Record<string, unknown>) : null,
      reason: a.reason,
    }));
    const byId = (id: string) => audits.filter((a) => a.id === id);
    expect(audits).toHaveLength(4);
    expect(byId('A')[0]).toMatchObject({ action: 'delete', after: null });
    expect(byId('C')[0]).toMatchObject({ action: 'delete', after: null });
    expect(byId('B')[0]).toMatchObject({
      action: 'update',
      before: { targetCount: 4 },
      after: { targetCount: 5 },
    });
    expect(byId('D')[0]).toMatchObject({
      action: 'update',
      before: { weekday: 5 },
      after: { weekday: null },
    });
    // The whole entity shape, so a mistyped json_object key in the migration fails here.
    expect(byId('B')[0]!.before).toEqual({
      id: 'B',
      unitId: 'u1',
      shiftTypeId: 's1',
      weekday: 1,
      date: null,
      role: 'RN',
      minCount: 5,
      targetCount: 4,
    });
    for (const a of audits) expect(a.reason.length).toBeGreaterThan(0);
    opened.sqlite.close();
  });
});

describe('pay rates from before they had a key', () => {
  it('keeps the pay rate that was already pricing shifts when an older file has two from the same day', () => {
    const { opened } = olderFile('_pay_rate_keys');
    const { sqlite } = opened;
    insertRow(sqlite, 'unit', { id: 'u1', name: '4 West' });
    insertRow(sqlite, 'nurse', { id: 'ana', unit_id: 'u1', first_name: 'Ana', last_name: 'Lopez' });
    const rate = (
      id: string,
      nurse: string | null,
      role: string | null,
      dollars: number,
      d: string,
    ) =>
      insertRow(sqlite, 'pay_rate', {
        id,
        nurse_id: nurse,
        role,
        hourly_rate: dollars,
        effective_from: d,
      });
    rate('a60', 'ana', null, 60, '2026-01-01');
    rate('a62', 'ana', null, 62, '2026-01-01');
    rate('r48', null, 'RN', 48, '2026-01-04');
    rate('r50', null, 'RN', 50, '2026-01-04');
    // Same date as Ana's first rate but a different scope: stays.
    rate('r44', null, 'RN', 44, '2026-01-01');

    migrateDatabase(opened.db, FULL);

    const left = sqlite.prepare('SELECT id, hourly_rate FROM pay_rate ORDER BY rowid').all();
    expect(left).toEqual([
      { id: 'a60', hourly_rate: 60 },
      { id: 'r48', hourly_rate: 48 },
      { id: 'r44', hourly_rate: 44 },
    ]);
    const audits = (
      sqlite
        .prepare(
          `SELECT action, before, after, reason FROM audit_log
           WHERE actor = 'upgrade' AND entity_type = 'pay_rate' ORDER BY rowid`,
        )
        .all() as { action: string; before: string; after: string | null; reason: string }[]
    ).map((a) => ({ ...a, before: JSON.parse(a.before) as Record<string, unknown> }));
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.action)).toEqual(['delete', 'delete']);
    expect(audits.map((a) => a.before.hourlyRate).sort()).toEqual([50, 62]);
    expect(audits.find((a) => a.before.hourlyRate === 62)?.before).toEqual({
      id: 'a62',
      nurseId: 'ana',
      role: null,
      hourlyRate: 62,
      effectiveFrom: '2026-01-01',
    });
    expect(audits.find((a) => a.before.hourlyRate === 50)?.before).toEqual({
      id: 'r50',
      nurseId: null,
      role: 'RN',
      hourlyRate: 50,
      effectiveFrom: '2026-01-04',
    });
    for (const a of audits) expect(a.reason.length).toBeGreaterThan(0);
    opened.sqlite.close();
  });
});

describe('float records once shift types stopped cascading into them', () => {
  it('keeps every float record through the upgrade, and a shift type delete no longer erases them', () => {
    const { opened } = olderFile('_float_record_shift_type_no_cascade');
    const { sqlite } = opened;
    // The older file already has the validation triggers (0043), so these rows are real ones.
    insertRow(sqlite, 'unit', {
      id: 'u1',
      name: '4 West',
      pay_period_days: 14,
      pay_period_anchor: '2026-01-04',
    });
    insertRow(sqlite, 'shift_type', {
      id: 's1',
      unit_id: 'u1',
      name: 'Day 12',
      abbreviation: 'D',
      start_time: '07:00',
      duration_hours: 12,
    });
    insertRow(sqlite, 'nurse', {
      id: 'ana',
      unit_id: 'u1',
      first_name: 'Ana',
      last_name: 'Lopez',
      role: 'RN',
      employment_type: 'full_time',
      fte: 1,
      contracted_hours_per_period: 72,
      seniority_date: '2019-03-01',
    });
    const record = {
      id: 'f1',
      unit_id: 'u1',
      nurse_id: 'ana',
      date: '2026-01-16',
      shift_type_id: 's1',
      to_unit: '5 East',
      volunteered: 1,
      objection: 'Not oriented to telemetry',
      actor: 'manager',
      at: 1_768_550_400_000,
    };
    insertRow(sqlite, 'float_record', record);
    const fk = () =>
      (
        sqlite.prepare('PRAGMA foreign_key_list(float_record)').all() as {
          from: string;
          on_delete: string;
        }[]
      ).find((f) => f.from === 'shift_type_id')?.on_delete;
    expect(fk()).toBe('CASCADE');

    migrateDatabase(opened.db, FULL);

    expect(sqlite.prepare('SELECT * FROM float_record').all()).toEqual([record]);
    expect(fk()).toBe('NO ACTION');
    const indexes = (
      sqlite.prepare('PRAGMA index_list(float_record)').all() as { name: string }[]
    ).map((i) => i.name);
    expect(indexes).toContain('float_record_unit_date_idx');
    expect(() => sqlite.prepare('DELETE FROM shift_type').run()).toThrow(/FOREIGN KEY/);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM float_record').get()).toEqual({ n: 1 });
    opened.sqlite.close();
  });
});

describe('files from before history was append-only', () => {
  it('adds the history triggers to an older file', () => {
    const { opened } = olderFile('_history_is_append_only');
    const triggerNames = [
      'rule_set',
      'rule_config',
      'schedule_version',
      'schedule_change',
      'pay_config_snapshot',
    ].flatMap((table) => [`${table}_no_update`, `${table}_no_delete`]);
    // Exact names, not LIKE: `_` is a wildcard there. Proves the migration creates them.
    const before = opened.sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${triggerNames.map(() => '?').join(', ')})`,
      )
      .all(...triggerNames);
    expect(before).toEqual([]);
    migrateDatabase(opened.db, FULL);
    const names = (
      opened.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const table of [
      'rule_set',
      'rule_config',
      'schedule_version',
      'schedule_change',
      'pay_config_snapshot',
    ]) {
      expect(names).toContain(`${table}_no_update`);
      expect(names).toContain(`${table}_no_delete`);
    }
    opened.sqlite.close();
  });
});

/**
 * Insert with the columns given. Any other NOT NULL column without a default gets a neutral
 * value of its type, so a test names only the columns the migration under test reads.
 */
function insertRow(
  sqlite: Database.Database,
  table: string,
  values: Record<string, unknown>,
): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }[];
  const row: Record<string, unknown> = { ...values };
  for (const c of columns) {
    if (c.name in row || !c.notnull || c.dflt_value !== null) continue;
    row[c.name] = c.type.toLowerCase() === 'integer' ? 0 : 'x';
  }
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => row[k]));
}
