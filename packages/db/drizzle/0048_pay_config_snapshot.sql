CREATE TABLE `pay_config_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`seq` integer NOT NULL,
	`taken_at` integer NOT NULL,
	`taken_by` text NOT NULL,
	`reason` text,
	`config` text NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `schedule_period`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pay_config_snapshot_period_seq_idx` ON `pay_config_snapshot` (`period_id`,`seq`);