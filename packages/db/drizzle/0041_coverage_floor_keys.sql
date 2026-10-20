-- Make a coverage floor unique per (unit, shift type, role, weekday) or per (..., date).
-- Older files could hold rows core read in ways the manager never saw, so each is repaired to
-- what core was already applying (the 0007 precedent: keep the row the app has been reading),
-- and every change is written to audit_log with actor 'upgrade':
--   1. weekday AND date: core treated it as a date override, so the weekday is cleared.
--   2. neither: it applied nowhere, so it is removed.
--   3. duplicates: core keeps the last match in row order, so the highest rowid stays.
--   4. minimum above target: core read the target as the minimum, so the target is raised.
INSERT INTO `audit_log` (`id`, `entity_type`, `entity_id`, `action`, `actor`, `before`, `after`, `reason`)
SELECT 'aud_' || lower(hex(randomblob(16))), 'coverage_requirement', `id`, 'update', 'upgrade',
  json_object('id', `id`, 'unitId', `unit_id`, 'shiftTypeId', `shift_type_id`, 'weekday', `weekday`, 'date', `date`, 'role', `role`, 'minCount', `min_count`, 'targetCount', `target_count`),
  json_object('id', `id`, 'unitId', `unit_id`, 'shiftTypeId', `shift_type_id`, 'weekday', NULL, 'date', `date`, 'role', `role`, 'minCount', `min_count`, 'targetCount', `target_count`), 'A floor with both a weekday and a date only ever applied on its date; the weekday was cleared on upgrade.'
FROM `coverage_requirement` WHERE `weekday` IS NOT NULL AND `date` IS NOT NULL;--> statement-breakpoint
UPDATE `coverage_requirement` SET `weekday` = NULL WHERE `weekday` IS NOT NULL AND `date` IS NOT NULL;--> statement-breakpoint
INSERT INTO `audit_log` (`id`, `entity_type`, `entity_id`, `action`, `actor`, `before`, `after`, `reason`)
SELECT 'aud_' || lower(hex(randomblob(16))), 'coverage_requirement', `id`, 'delete', 'upgrade',
  json_object('id', `id`, 'unitId', `unit_id`, 'shiftTypeId', `shift_type_id`, 'weekday', `weekday`, 'date', `date`, 'role', `role`, 'minCount', `min_count`, 'targetCount', `target_count`),
  NULL, 'A floor with no weekday and no date never applied; removed on upgrade.'
FROM `coverage_requirement` WHERE `weekday` IS NULL AND `date` IS NULL;--> statement-breakpoint
DELETE FROM `coverage_requirement` WHERE `weekday` IS NULL AND `date` IS NULL;--> statement-breakpoint
INSERT INTO `audit_log` (`id`, `entity_type`, `entity_id`, `action`, `actor`, `before`, `after`, `reason`)
SELECT 'aud_' || lower(hex(randomblob(16))), 'coverage_requirement', `id`, 'delete', 'upgrade',
  json_object('id', `id`, 'unitId', `unit_id`, 'shiftTypeId', `shift_type_id`, 'weekday', `weekday`, 'date', `date`, 'role', `role`, 'minCount', `min_count`, 'targetCount', `target_count`),
  NULL, 'A second floor for the same shift, role and day was never the one applied; removed on upgrade.'
FROM `coverage_requirement` WHERE `date` IS NULL AND EXISTS (SELECT 1 FROM `coverage_requirement` o WHERE o.`unit_id` = `coverage_requirement`.`unit_id` AND o.`shift_type_id` = `coverage_requirement`.`shift_type_id` AND o.`role` = `coverage_requirement`.`role` AND o.`date` IS NULL AND o.`weekday` = `coverage_requirement`.`weekday` AND o.rowid > `coverage_requirement`.rowid);--> statement-breakpoint
DELETE FROM `coverage_requirement` WHERE `date` IS NULL AND EXISTS (SELECT 1 FROM `coverage_requirement` o WHERE o.`unit_id` = `coverage_requirement`.`unit_id` AND o.`shift_type_id` = `coverage_requirement`.`shift_type_id` AND o.`role` = `coverage_requirement`.`role` AND o.`date` IS NULL AND o.`weekday` = `coverage_requirement`.`weekday` AND o.rowid > `coverage_requirement`.rowid);--> statement-breakpoint
INSERT INTO `audit_log` (`id`, `entity_type`, `entity_id`, `action`, `actor`, `before`, `after`, `reason`)
SELECT 'aud_' || lower(hex(randomblob(16))), 'coverage_requirement', `id`, 'delete', 'upgrade',
  json_object('id', `id`, 'unitId', `unit_id`, 'shiftTypeId', `shift_type_id`, 'weekday', `weekday`, 'date', `date`, 'role', `role`, 'minCount', `min_count`, 'targetCount', `target_count`),
  NULL, 'A second floor for the same shift, role and day was never the one applied; removed on upgrade.'
FROM `coverage_requirement` WHERE `date` IS NOT NULL AND EXISTS (SELECT 1 FROM `coverage_requirement` o WHERE o.`unit_id` = `coverage_requirement`.`unit_id` AND o.`shift_type_id` = `coverage_requirement`.`shift_type_id` AND o.`role` = `coverage_requirement`.`role` AND o.`date` = `coverage_requirement`.`date` AND o.rowid > `coverage_requirement`.rowid);--> statement-breakpoint
DELETE FROM `coverage_requirement` WHERE `date` IS NOT NULL AND EXISTS (SELECT 1 FROM `coverage_requirement` o WHERE o.`unit_id` = `coverage_requirement`.`unit_id` AND o.`shift_type_id` = `coverage_requirement`.`shift_type_id` AND o.`role` = `coverage_requirement`.`role` AND o.`date` = `coverage_requirement`.`date` AND o.rowid > `coverage_requirement`.rowid);--> statement-breakpoint
INSERT INTO `audit_log` (`id`, `entity_type`, `entity_id`, `action`, `actor`, `before`, `after`, `reason`)
SELECT 'aud_' || lower(hex(randomblob(16))), 'coverage_requirement', `id`, 'update', 'upgrade',
  json_object('id', `id`, 'unitId', `unit_id`, 'shiftTypeId', `shift_type_id`, 'weekday', `weekday`, 'date', `date`, 'role', `role`, 'minCount', `min_count`, 'targetCount', `target_count`),
  json_object('id', `id`, 'unitId', `unit_id`, 'shiftTypeId', `shift_type_id`, 'weekday', `weekday`, 'date', `date`, 'role', `role`, 'minCount', `min_count`, 'targetCount', `min_count`), 'The target was below the minimum and was read as the minimum; set to match on upgrade.'
FROM `coverage_requirement` WHERE `min_count` > `target_count`;--> statement-breakpoint
UPDATE `coverage_requirement` SET `target_count` = `min_count` WHERE `min_count` > `target_count`;--> statement-breakpoint
CREATE UNIQUE INDEX `coverage_weekday_key_idx` ON `coverage_requirement` (`unit_id`,`shift_type_id`,`role`,`weekday`) WHERE date is null;--> statement-breakpoint
CREATE UNIQUE INDEX `coverage_date_key_idx` ON `coverage_requirement` (`unit_id`,`shift_type_id`,`role`,`date`) WHERE date is not null;