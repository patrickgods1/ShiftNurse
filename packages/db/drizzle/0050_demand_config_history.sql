CREATE TABLE `demand_config_dirty` (
	`unit_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `demand_config_version` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`seq` integer NOT NULL,
	`effective_at` integer NOT NULL,
	`taken_by` text NOT NULL,
	`reason` text,
	`config` text NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demand_config_version_unit_seq_idx` ON `demand_config_version` (`unit_id`,`seq`);--> statement-breakpoint
-- The demand rules a past date was judged by are history, kept append-only like 0049's tables.
-- A unit's cascade delete reaches this table too, so a unit with demand history cannot be deleted.
CREATE TRIGGER `demand_config_version_no_update` BEFORE UPDATE ON `demand_config_version`
BEGIN
  SELECT RAISE(ABORT, 'The demand rules a unit had in force cannot be changed; record a new version instead.');
END;
--> statement-breakpoint
CREATE TRIGGER `demand_config_version_no_delete` BEFORE DELETE ON `demand_config_version`
BEGIN
  SELECT RAISE(ABORT, 'The demand rules a unit had in force cannot be deleted: past schedules were judged by them.');
END;
--> statement-breakpoint
-- Missed-writer guard. Every repository writer of the demand tables records a version itself; a
-- path that forgets (a new writer, a seed, a hand edit of the file) leaves its unit here, and the
-- startup backfill records the version. Update triggers fire only on the columns a version holds,
-- and only when a value really changed: deactivateShiftType and deactivateRatioRule rewrite the
-- whole row. A changed unit_id marks both units.
CREATE TRIGGER `ratio_rule_demand_insert` AFTER INSERT ON `ratio_rule`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (NEW.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `ratio_rule_demand_delete` AFTER DELETE ON `ratio_rule`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (OLD.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `ratio_rule_demand_update`
AFTER UPDATE OF `unit_id`, `role`, `acuity_tier_id`, `max_patients_per_nurse`, `citation`, `min_rn_share`, `active` ON `ratio_rule`
WHEN OLD.`unit_id` IS NOT NEW.`unit_id`
  OR OLD.`role` IS NOT NEW.`role`
  OR OLD.`acuity_tier_id` IS NOT NEW.`acuity_tier_id`
  OR OLD.`max_patients_per_nurse` IS NOT NEW.`max_patients_per_nurse`
  OR OLD.`citation` IS NOT NEW.`citation`
  OR OLD.`min_rn_share` IS NOT NEW.`min_rn_share`
  OR OLD.`active` IS NOT NEW.`active`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (OLD.`unit_id`), (NEW.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `coverage_requirement_demand_insert` AFTER INSERT ON `coverage_requirement`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (NEW.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `coverage_requirement_demand_delete` AFTER DELETE ON `coverage_requirement`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (OLD.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `coverage_requirement_demand_update`
AFTER UPDATE OF `unit_id`, `shift_type_id`, `weekday`, `date`, `role`, `min_count`, `target_count` ON `coverage_requirement`
WHEN OLD.`unit_id` IS NOT NEW.`unit_id`
  OR OLD.`shift_type_id` IS NOT NEW.`shift_type_id`
  OR OLD.`weekday` IS NOT NEW.`weekday`
  OR OLD.`date` IS NOT NEW.`date`
  OR OLD.`role` IS NOT NEW.`role`
  OR OLD.`min_count` IS NOT NEW.`min_count`
  OR OLD.`target_count` IS NOT NEW.`target_count`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (OLD.`unit_id`), (NEW.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `acuity_tier_demand_insert` AFTER INSERT ON `acuity_tier`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (NEW.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `acuity_tier_demand_delete` AFTER DELETE ON `acuity_tier`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (OLD.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `acuity_tier_demand_update`
AFTER UPDATE OF `unit_id`, `name`, `level`, `care_hours_per_patient_day` ON `acuity_tier`
WHEN OLD.`unit_id` IS NOT NEW.`unit_id`
  OR OLD.`name` IS NOT NEW.`name`
  OR OLD.`level` IS NOT NEW.`level`
  OR OLD.`care_hours_per_patient_day` IS NOT NEW.`care_hours_per_patient_day`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (OLD.`unit_id`), (NEW.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `shift_type_demand_insert` AFTER INSERT ON `shift_type`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (NEW.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `shift_type_demand_delete` AFTER DELETE ON `shift_type`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (OLD.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `shift_type_demand_update` AFTER UPDATE OF `active` ON `shift_type`
WHEN OLD.`active` IS NOT NEW.`active`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (NEW.`unit_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `unit_demand_update`
AFTER UPDATE OF `charge_nurse_takes_patients`, `break_minutes_per_nurse`, `charge_covers_breaks` ON `unit`
WHEN OLD.`charge_nurse_takes_patients` IS NOT NEW.`charge_nurse_takes_patients`
  OR OLD.`break_minutes_per_nurse` IS NOT NEW.`break_minutes_per_nurse`
  OR OLD.`charge_covers_breaks` IS NOT NEW.`charge_covers_breaks`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (NEW.`id`);
END;
