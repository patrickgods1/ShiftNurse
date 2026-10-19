-- Make a pay rate unique per (nurse, start date) or per (role default, start date).
-- Core's latestRateInForce keeps the first of two rates with the same start date and rows were
-- read in insertion order, so the lowest rowid is the rate that was pricing shifts (the 0007
-- precedent: keep the row the app has been reading). Each other row is written to audit_log with
-- actor 'upgrade' and then removed.
INSERT INTO `audit_log` (`id`, `entity_type`, `entity_id`, `action`, `actor`, `before`, `after`, `reason`)
SELECT 'aud_' || lower(hex(randomblob(16))), 'pay_rate', `id`, 'delete', 'upgrade',
  json_object('id', `id`, 'nurseId', `nurse_id`, 'role', `role`, 'hourlyRate', `hourly_rate`, 'effectiveFrom', `effective_from`),
  NULL, 'A second rate from the same start date was never used for pricing (the first one entered was); removed on upgrade. If it was a correction, change the remaining rate to it.'
FROM `pay_rate` WHERE (`nurse_id` IS NOT NULL AND EXISTS (SELECT 1 FROM `pay_rate` o WHERE o.`nurse_id` = `pay_rate`.`nurse_id` AND o.`effective_from` = `pay_rate`.`effective_from` AND o.rowid < `pay_rate`.rowid)) OR (`nurse_id` IS NULL AND EXISTS (SELECT 1 FROM `pay_rate` o WHERE o.`nurse_id` IS NULL AND o.`role` = `pay_rate`.`role` AND o.`effective_from` = `pay_rate`.`effective_from` AND o.rowid < `pay_rate`.rowid));--> statement-breakpoint
DELETE FROM `pay_rate` WHERE (`nurse_id` IS NOT NULL AND EXISTS (SELECT 1 FROM `pay_rate` o WHERE o.`nurse_id` = `pay_rate`.`nurse_id` AND o.`effective_from` = `pay_rate`.`effective_from` AND o.rowid < `pay_rate`.rowid)) OR (`nurse_id` IS NULL AND EXISTS (SELECT 1 FROM `pay_rate` o WHERE o.`nurse_id` IS NULL AND o.`role` = `pay_rate`.`role` AND o.`effective_from` = `pay_rate`.`effective_from` AND o.rowid < `pay_rate`.rowid));--> statement-breakpoint
CREATE UNIQUE INDEX `pay_rate_nurse_date_idx` ON `pay_rate` (`nurse_id`,`effective_from`) WHERE nurse_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `pay_rate_role_date_idx` ON `pay_rate` (`role`,`effective_from`) WHERE nurse_id is null;