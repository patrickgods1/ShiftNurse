CREATE TABLE `cancellation_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`tiers` text NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cancellation_policy_unit_id_unique` ON `cancellation_policy` (`unit_id`);--> statement-breakpoint
CREATE TABLE `shift_cancellation` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`date` text NOT NULL,
	`reason` text NOT NULL,
	`cancelled_at` integer NOT NULL,
	`entered_by` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shift_cancellation_nurse_date_idx` ON `shift_cancellation` (`nurse_id`,`date`);--> statement-breakpoint
CREATE INDEX `shift_cancellation_period_date_idx` ON `shift_cancellation` (`period_id`,`date`);