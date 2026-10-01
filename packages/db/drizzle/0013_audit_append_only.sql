-- The audit log is quoted when a decision is challenged, so it must say what it said on the day.
-- Nothing in the app updates or deletes a row; these triggers make that a property of the file
-- rather than of the code that happens to touch it. Start over and restore replace the whole
-- file instead, which these do not stop.
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
