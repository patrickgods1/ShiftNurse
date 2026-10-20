ALTER TABLE `fairness_ledger` ADD `period_days` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `fairness_ledger` ADD `available_days` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill (hand-written). A row's length is its schedule period's; imported history
-- (`import:<start>`) has no schedule_period and is a pay period by construction
-- (groupIntoPayPeriods), so the unit's pay_period_days is its length. julianday on ISO date
-- strings is calendar arithmetic with no time zone. Availability is the days of that length on
-- or after the nurse's hire date and inside no approved time-off request, as core's daysAvailable.
UPDATE `fairness_ledger` SET `period_days` = COALESCE(
  (SELECT CAST(julianday(sp.`end_date`) - julianday(sp.`start_date`) AS INTEGER) + 1
     FROM `schedule_period` sp WHERE sp.`id` = `fairness_ledger`.`period_id`),
  (SELECT u.`pay_period_days` FROM `nurse` n JOIN `unit` u ON u.`id` = n.`unit_id`
     WHERE n.`id` = `fairness_ledger`.`nurse_id`));
--> statement-breakpoint
UPDATE `fairness_ledger` SET `available_days` = (
  WITH RECURSIVE d(day, k) AS (
    SELECT `fairness_ledger`.`period_start`, 1
    UNION ALL
    SELECT date(day, '+1 day'), k + 1 FROM d WHERE k < `fairness_ledger`.`period_days`)
  SELECT count(*) FROM d
  WHERE NOT EXISTS (SELECT 1 FROM `time_off_request` t
                     WHERE t.`nurse_id` = `fairness_ledger`.`nurse_id` AND t.`status` = 'approved'
                       AND t.`start_date` <= d.day AND t.`end_date` >= d.day)
    AND NOT EXISTS (SELECT 1 FROM `nurse` n
                     WHERE n.`id` = `fairness_ledger`.`nurse_id` AND n.`hire_date` IS NOT NULL
                       AND d.day < n.`hire_date`));
