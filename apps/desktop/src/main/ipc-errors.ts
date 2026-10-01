/**
 * The wording of an error that crosses IPC.
 *
 * The app's own refusals ("That shift is locked…") are written for a nurse manager and pass
 * through unchanged. SQLite's are not: `UNIQUE constraint failed: assignment.nurse_id,
 * assignment.date, assignment.shift_type_id` is the database describing itself. Those are
 * reworded here, in the one place every IPC call fails through; the original is logged.
 */

/** Duplicates the UI can hit, keyed by the table SQLite names in the message. */
const DUPLICATE: Record<string, string> = {
  assignment: 'That nurse already has that shift on that day.',
  nurse: 'Another nurse on this unit already has that employee ID.',
  nurse_credential: 'That nurse already holds that credential.',
  census_forecast: 'There is already a census entry for that shift and day.',
  holiday: 'There is already a holiday on that date.',
  budget: 'That period already has a budget.',
  fairness_ledger: 'History for that nurse and period has already been recorded.',
  rule_set: 'The rules changed while you were saving. Reload and try again.',
  schedule_version: 'That schedule changed while it was being published. Reload and try again.',
};

const UNIQUE = /^UNIQUE constraint failed: (\w+)\./;

function sqliteCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code: unknown };
  return typeof code === 'string' && code.startsWith('SQLITE_') ? code : undefined;
}

export function userFacingMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = sqliteCode(err);
  if (code === undefined) return message;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const table = UNIQUE.exec(message)?.[1];
    if (table !== undefined && DUPLICATE[table] !== undefined) return DUPLICATE[table];
    return `That would duplicate an existing ${table?.replace(/_/g, ' ') ?? 'record'}.`;
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return (
      'That change refers to something that no longer exists, or that is still in use ' +
      'elsewhere. Reload and try again.'
    );
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return 'The database is busy (a backup may be running). Try again in a moment.';
  }
  if (code === 'SQLITE_FULL') return 'The disk is full, so the change could not be saved.';
  return `The database refused the change (${code}). The details are in the log file.`;
}
