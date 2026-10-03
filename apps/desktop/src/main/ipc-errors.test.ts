import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { stripIpcPrefix } from '../shared/ipc-error.js';
import { userFacingMessage } from './ipc-errors.js';

/** A real SqliteError, thrown by the driver the app uses, rather than a hand-built look-alike. */
function sqliteError(setup: string, failing: string): unknown {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(setup);
  try {
    db.exec(failing);
  } catch (err) {
    return err;
  } finally {
    db.close();
  }
  throw new Error('expected the statement to fail');
}

describe('what a manager reads when a change is refused', () => {
  it('says the nurse already works that shift instead of quoting a unique index', () => {
    const err = sqliteError(
      'CREATE TABLE assignment (nurse_id, date, shift_type_id, UNIQUE (nurse_id, date, shift_type_id));' +
        "INSERT INTO assignment VALUES ('n1', '2026-10-05', 'D12');",
      "INSERT INTO assignment VALUES ('n1', '2026-10-05', 'D12');",
    );
    expect(userFacingMessage(err)).toBe('That nurse already has that shift on that day.');
  });

  it('says another nurse has the employee id when an add repeats one', () => {
    const err = sqliteError(
      "CREATE TABLE nurse (unit_id, employee_id, UNIQUE (unit_id, employee_id)); INSERT INTO nurse VALUES ('u', 'E1');",
      "INSERT INTO nurse VALUES ('u', 'E1');",
    );
    expect(userFacingMessage(err)).toBe('Another nurse on this unit already has that employee ID.');
  });

  it('falls back to naming the kind of record for a duplicate it has no wording for', () => {
    const err = sqliteError(
      "CREATE TABLE pay_rate (id UNIQUE); INSERT INTO pay_rate VALUES ('x');",
      "INSERT INTO pay_rate VALUES ('x');",
    );
    expect(userFacingMessage(err)).toBe('That would duplicate an existing pay rate.');
  });

  it('asks for a reload when a change points at something deleted in the meantime', () => {
    const err = sqliteError(
      'CREATE TABLE p (id PRIMARY KEY); CREATE TABLE c (pid REFERENCES p(id));',
      "INSERT INTO c VALUES ('gone');",
    );
    expect(userFacingMessage(err)).toMatch(/no longer exists.*Reload/);
  });

  it('passes the app’s own refusals through word for word', () => {
    expect(userFacingMessage(new Error('That shift is locked; unlock it to move it.'))).toBe(
      'That shift is locked; unlock it to move it.',
    );
  });
});

describe('the message the renderer receives', () => {
  it('drops the wrapper Electron puts around every rejected call', () => {
    expect(
      stripIpcPrefix(
        "Error invoking remote method 'schedule.move': Error: That shift is locked; unlock it to move it.",
      ),
    ).toBe('That shift is locked; unlock it to move it.');
  });

  it('leaves a message without the wrapper alone', () => {
    expect(stripIpcPrefix('Error: keep me')).toBe('Error: keep me');
  });
});
