-- Validation backstops for the columns core divides by and branches on. IPC (zod) and the roster
-- CSV importer already refuse these values, but seeds, presets and any future path write straight
-- to the file: a pay period of 0 days makes leave capacity divide by zero, a negative contract
-- reads as per diem, and an unknown role or status falls through every branch with no error.
--
-- Triggers rather than CHECK constraints: SQLite adds a CHECK only by rebuilding the table, and
-- nurse, unit and schedule_period have children, so the drizzle migrator's one-transaction table
-- swap (where PRAGMA foreign_keys=OFF is a no-op) would cascade the drop into them (see 0005).
--
-- `date(x) IS NOT x` is the date test: date() returns NULL for a non-date and normalises an
-- impossible one (date('2026-02-30') is '2026-03-02'), so only a real YYYY-MM-DD equals itself.
--
-- The update triggers fire only on the guarded columns (BEFORE UPDATE OF ...), so a row stored
-- with a bad value before this migration can still be deactivated or renamed.
--
-- nurse_keeps_history: assignment, schedule_change and fairness_ledger cascade from nurse in the
-- schema, so deleting a nurse would erase her published shifts, the post-publish change log and
-- her fairness history. Nothing deletes a nurse today; this makes that a property of the file.
-- SQLite fires it for a cascade from unit too, so deleting a unit with history is refused as well.
CREATE TRIGGER `nurse_valid_insert` BEFORE INSERT ON `nurse`
BEGIN
  SELECT CASE
    WHEN NEW.`role` NOT IN ('RN', 'LPN', 'CNA')
      THEN RAISE(ABORT, 'A nurse''s role must be RN, LPN or CNA.')
    WHEN NEW.`employment_type` NOT IN ('full_time', 'part_time', 'per_diem', 'agency')
      THEN RAISE(ABORT, 'A nurse''s employment type must be full time, part time, per diem or agency.')
    WHEN NEW.`fte` < 0 OR NEW.`fte` > 1.5
      THEN RAISE(ABORT, 'A nurse''s FTE must be from 0 to 1.5.')
    WHEN NEW.`contracted_hours_per_period` < 0
      THEN RAISE(ABORT, 'Contracted hours cannot be negative.')
    WHEN date(NEW.`seniority_date`) IS NOT NEW.`seniority_date`
      THEN RAISE(ABORT, 'A nurse''s seniority date must be a date.')
    WHEN NEW.`hire_date` IS NOT NULL AND date(NEW.`hire_date`) IS NOT NEW.`hire_date`
      THEN RAISE(ABORT, 'A nurse''s hire date must be a date.')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `nurse_valid_update`
BEFORE UPDATE OF `role`, `employment_type`, `fte`, `contracted_hours_per_period`, `seniority_date`, `hire_date` ON `nurse`
BEGIN
  SELECT CASE
    WHEN NEW.`role` NOT IN ('RN', 'LPN', 'CNA')
      THEN RAISE(ABORT, 'A nurse''s role must be RN, LPN or CNA.')
    WHEN NEW.`employment_type` NOT IN ('full_time', 'part_time', 'per_diem', 'agency')
      THEN RAISE(ABORT, 'A nurse''s employment type must be full time, part time, per diem or agency.')
    WHEN NEW.`fte` < 0 OR NEW.`fte` > 1.5
      THEN RAISE(ABORT, 'A nurse''s FTE must be from 0 to 1.5.')
    WHEN NEW.`contracted_hours_per_period` < 0
      THEN RAISE(ABORT, 'Contracted hours cannot be negative.')
    WHEN date(NEW.`seniority_date`) IS NOT NEW.`seniority_date`
      THEN RAISE(ABORT, 'A nurse''s seniority date must be a date.')
    WHEN NEW.`hire_date` IS NOT NULL AND date(NEW.`hire_date`) IS NOT NEW.`hire_date`
      THEN RAISE(ABORT, 'A nurse''s hire date must be a date.')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `unit_valid_insert` BEFORE INSERT ON `unit`
BEGIN
  SELECT CASE
    WHEN typeof(NEW.`pay_period_days`) <> 'integer' OR NEW.`pay_period_days` < 1
      THEN RAISE(ABORT, 'A pay period must be a whole number of days, at least one.')
    WHEN date(NEW.`pay_period_anchor`) IS NOT NEW.`pay_period_anchor`
      THEN RAISE(ABORT, 'The pay period''s first day must be a date.')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `unit_valid_update` BEFORE UPDATE OF `pay_period_days`, `pay_period_anchor` ON `unit`
BEGIN
  SELECT CASE
    WHEN typeof(NEW.`pay_period_days`) <> 'integer' OR NEW.`pay_period_days` < 1
      THEN RAISE(ABORT, 'A pay period must be a whole number of days, at least one.')
    WHEN date(NEW.`pay_period_anchor`) IS NOT NEW.`pay_period_anchor`
      THEN RAISE(ABORT, 'The pay period''s first day must be a date.')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `schedule_period_valid_insert` BEFORE INSERT ON `schedule_period`
BEGIN
  SELECT CASE
    WHEN NEW.`status` NOT IN ('draft', 'published', 'archived')
      THEN RAISE(ABORT, 'A schedule period is draft, published or archived.')
    WHEN date(NEW.`start_date`) IS NOT NEW.`start_date` OR date(NEW.`end_date`) IS NOT NEW.`end_date`
      THEN RAISE(ABORT, 'A schedule period''s start and end must be dates.')
    WHEN NEW.`end_date` < NEW.`start_date`
      THEN RAISE(ABORT, 'The period ends before it starts.')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `schedule_period_valid_update`
BEFORE UPDATE OF `status`, `start_date`, `end_date` ON `schedule_period`
BEGIN
  SELECT CASE
    WHEN NEW.`status` NOT IN ('draft', 'published', 'archived')
      THEN RAISE(ABORT, 'A schedule period is draft, published or archived.')
    WHEN date(NEW.`start_date`) IS NOT NEW.`start_date` OR date(NEW.`end_date`) IS NOT NEW.`end_date`
      THEN RAISE(ABORT, 'A schedule period''s start and end must be dates.')
    WHEN NEW.`end_date` < NEW.`start_date`
      THEN RAISE(ABORT, 'The period ends before it starts.')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `nurse_keeps_history` BEFORE DELETE ON `nurse`
WHEN EXISTS (SELECT 1 FROM `assignment` WHERE `nurse_id` = OLD.`id`)
  OR EXISTS (SELECT 1 FROM `schedule_change` WHERE `nurse_id` = OLD.`id`)
  OR EXISTS (SELECT 1 FROM `fairness_ledger` WHERE `nurse_id` = OLD.`id`)
BEGIN
  SELECT RAISE(ABORT, 'A nurse with schedule history cannot be deleted; deactivate them instead.');
END;
