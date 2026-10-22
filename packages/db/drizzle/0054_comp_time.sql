CREATE TABLE `comp_time_credit` (
	`id` text PRIMARY KEY NOT NULL,
	`nurse_id` text NOT NULL,
	`period_id` text NOT NULL,
	`overtime_hours` real NOT NULL,
	`credited_hours` real NOT NULL,
	`paid_overtime_hours` real NOT NULL,
	`created_at` integer NOT NULL,
	`reason` text,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`period_id`) REFERENCES `schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comp_time_credit_nurse_period_idx` ON `comp_time_credit` (`nurse_id`,`period_id`);--> statement-breakpoint
CREATE TABLE `comp_time_election` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`note` text,
	`created_at` integer NOT NULL,
	`entered_by` text NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comp_time_election_nurse_idx` ON `comp_time_election` (`nurse_id`);--> statement-breakpoint
ALTER TABLE `pay_settings` ADD `comp_time_hours_per_overtime_hour` real;--> statement-breakpoint
ALTER TABLE `pay_settings` ADD `comp_time_cap_hours` real;--> statement-breakpoint
-- A banked credit is what the nurse was told she holds. It is final once written; a wrong one is
-- corrected by entering payroll's comp balance, never by editing the credit. As in 0049, a later
-- migration that rebuilds this table must DROP TRIGGER and re-create these.
CREATE TRIGGER `comp_time_credit_no_update` BEFORE UPDATE ON `comp_time_credit`
BEGIN
  SELECT RAISE(ABORT, 'Banked comp time cannot be changed; correct the nurse''s comp balance under Leave instead.');
END;
--> statement-breakpoint
CREATE TRIGGER `comp_time_credit_no_delete` BEFORE DELETE ON `comp_time_credit`
BEGIN
  SELECT RAISE(ABORT, 'Banked comp time cannot be deleted: it was banked from a published schedule.');
END;
