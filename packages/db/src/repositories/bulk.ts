/**
 * Multi-row inserts. A regeneration writes several hundred assignments and a history import can
 * write thousands of ledger rows; one INSERT per row paid the statement overhead each time.
 * Chunked so a statement stays well under SQLite's bound-parameter limit (32,766 in the bundled
 * build) for any table here: 200 rows × 16 columns is 3,200.
 */

import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DbLike } from '../client.js';

const CHUNK_ROWS = 200;

export function insertRows<T extends SQLiteTable>(
  db: DbLike,
  table: T,
  rows: readonly T['$inferInsert'][],
): void {
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    db.insert(table)
      .values(rows.slice(i, i + CHUNK_ROWS) as T['$inferInsert'][])
      .run();
  }
}
