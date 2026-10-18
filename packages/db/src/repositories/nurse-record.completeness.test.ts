/**
 * Tripwires for the grievance record. `nurseRecord` finds an entry by text in its snapshot, so a
 * new audited entity, or a new column that points at a nurse under a new key, falls out of her
 * record without a single failure anywhere else (that is how holdovers, orientations and holiday
 * work went missing). These two tests make the omission loud. The lists below are written by
 * hand on purpose: derived from the code under test, they would agree with it by construction.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../schema.js';
import { NURSE_SCOPED } from './nurse-record.completeness.test-support.js';
import { RECORD_EXCLUDED_ENTITIES, RECORD_NURSE_KEYS } from './nurse-record.js';

/**
 * Configuration and unit-wide entries: none is about one nurse. `schedule_period`: a
 * regeneration's removed rows name nurses and are found by `nurseId` incidentally, but the
 * period itself is not about a nurse. `backup` is written in `apps/desktop`, so it is not
 * scanned here; it is not about a nurse either.
 */
const NOT_ABOUT_A_NURSE = [
  'acuity_tier',
  'budget',
  'cancellation_policy',
  'census_forecast',
  'conflict_policy',
  'coverage_requirement',
  'credential',
  'differential',
  'holiday',
  'hppd_target',
  'leave_bid_round',
  'overtime_rule',
  'pay_settings',
  'ratio_rule',
  'rule_set',
  'schedule_period',
  'schedule_version',
  'setup_state',
  'shift_credential_requirement',
  'shift_type',
  'solver_settings',
  'unit',
] as const;

describe('what the grievance record looks for', () => {
  it('looks for every column that points at a nurse', () => {
    const keys = new Set<string>();
    for (const value of Object.values(schema)) {
      if (!is(value, SQLiteTable)) continue;
      const columns: Record<string, unknown> = getTableColumns(value);
      for (const fk of getTableConfig(value).foreignKeys) {
        const { columns: from, foreignTable } = fk.reference();
        if (foreignTable !== schema.nurse) continue;
        for (const col of from) {
          const key = Object.keys(columns).find((k) => columns[k] === col);
          if (key === undefined) throw new Error(`A foreign key column has no property key`);
          keys.add(key);
        }
      }
    }
    expect([...keys].sort()).toEqual([
      'counterpartyNurseId',
      'nurseId',
      'orienteeId',
      'preceptorId',
      'requestingNurseId',
    ]);
    for (const key of keys) expect(RECORD_NURSE_KEYS).toContain(key);
  });

  it('has decided, for every kind of entry the app writes, whether it belongs in a nurse’s record', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const found = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.endsWith('.test-support.ts')) {
        continue;
      }
      const source = readFileSync(join(dir, file), 'utf8');
      // Every `entityType:` must resolve to a literal or a same-file constant, or the scan cannot
      // classify it: a dynamic value would otherwise escape the list unnoticed.
      for (const m of source.matchAll(/entityType:\s*([^\s,;})]+)/g)) {
        const value = m[1]!;
        const literal = /^'([a-z_]+)'$/.exec(value);
        if (literal) {
          found.add(literal[1]!);
          continue;
        }
        // A type annotation (`entityType: string;`), as in patch.ts's spec, names no entity.
        if (value === 'string') continue;
        // nurse-record.ts maps an audit row it has read (`entityType: r.entityType`); not a write.
        if (file === 'nurse-record.ts' && value === 'r.entityType') continue;
        const named = /^[A-Z][A-Z_]*$/.test(value)
          ? new RegExp(`const ${value} = '([a-z_]+)'`).exec(source)
          : null;
        if (!named)
          throw new Error(`${file} audits under \`${value}\`, which this test cannot resolve`);
        found.add(named[1]!);
      }
    }
    const decided = [...NURSE_SCOPED, ...RECORD_EXCLUDED_ENTITIES, ...NOT_ABOUT_A_NURSE];
    expect([...found].sort()).toEqual([...decided].sort());
  });
});
