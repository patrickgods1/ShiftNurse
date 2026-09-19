CREATE TABLE `schedule_change` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`version` integer NOT NULL,
	`kind` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`nurse_id` text NOT NULL,
	`date` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`before` text,
	`after` text,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedule_change_period_at_idx` ON `schedule_change` (`period_id`,`at`);--> statement-breakpoint
CREATE TABLE `schedule_version` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`version` integer NOT NULL,
	`published_at` integer NOT NULL,
	`published_by` text NOT NULL,
	`reason` text,
	`assignments` text NOT NULL,
	`added` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`changed` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `schedule_period`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_version_period_idx` ON `schedule_version` (`period_id`,`version`);