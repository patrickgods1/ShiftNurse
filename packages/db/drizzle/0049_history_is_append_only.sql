-- Rule set versions, published versions, the change log and pay snapshots are what a published
-- schedule is explained by. The app never changes or removes a row of them; these triggers make
-- that a property of the file, as 0013 did for audit_log.
-- SQLite fires them on foreign-key cascades too, so deleting a unit or a published period now
-- aborts (no app path does either). A later migration that rebuilds one of these tables or
-- backfills a column must DROP TRIGGER and re-create it inside the same migration.
CREATE TRIGGER `rule_set_no_update` BEFORE UPDATE ON `rule_set`
BEGIN
  SELECT RAISE(ABORT, 'A saved rule set version cannot be changed; save a new version instead.');
END;
--> statement-breakpoint
CREATE TRIGGER `rule_set_no_delete` BEFORE DELETE ON `rule_set`
BEGIN
  SELECT RAISE(ABORT, 'A saved rule set version cannot be deleted: schedules were judged by it.');
END;
--> statement-breakpoint
CREATE TRIGGER `rule_config_no_update` BEFORE UPDATE ON `rule_config`
BEGIN
  SELECT RAISE(ABORT, 'A saved rule set version cannot be changed; save a new version instead.');
END;
--> statement-breakpoint
CREATE TRIGGER `rule_config_no_delete` BEFORE DELETE ON `rule_config`
BEGIN
  SELECT RAISE(ABORT, 'A saved rule set version cannot be deleted: schedules were judged by it.');
END;
--> statement-breakpoint
CREATE TRIGGER `schedule_version_no_update` BEFORE UPDATE ON `schedule_version`
BEGIN
  SELECT RAISE(ABORT, 'A published version records what went out to staff and cannot be changed.');
END;
--> statement-breakpoint
CREATE TRIGGER `schedule_version_no_delete` BEFORE DELETE ON `schedule_version`
BEGIN
  SELECT RAISE(ABORT, 'A published version records what went out to staff and cannot be deleted.');
END;
--> statement-breakpoint
CREATE TRIGGER `schedule_change_no_update` BEFORE UPDATE ON `schedule_change`
BEGIN
  SELECT RAISE(ABORT, 'The change log of a published schedule cannot be changed.');
END;
--> statement-breakpoint
CREATE TRIGGER `schedule_change_no_delete` BEFORE DELETE ON `schedule_change`
BEGIN
  SELECT RAISE(ABORT, 'The change log of a published schedule cannot be deleted.');
END;
--> statement-breakpoint
CREATE TRIGGER `pay_config_snapshot_no_update` BEFORE UPDATE ON `pay_config_snapshot`
BEGIN
  SELECT RAISE(ABORT, 'The pay settings a schedule was priced under cannot be changed; reprice it instead.');
END;
--> statement-breakpoint
CREATE TRIGGER `pay_config_snapshot_no_delete` BEFORE DELETE ON `pay_config_snapshot`
BEGIN
  SELECT RAISE(ABORT, 'The pay settings a schedule was priced under cannot be deleted.');
END;
