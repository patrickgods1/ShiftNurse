CREATE TABLE `holiday_work` (
	`holiday_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	PRIMARY KEY(`holiday_id`, `nurse_id`),
	FOREIGN KEY (`holiday_id`) REFERENCES `holiday`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `holiday_work_nurse_idx` ON `holiday_work` (`nurse_id`);--> statement-breakpoint
ALTER TABLE `holiday` ADD `paired_holiday_id` text REFERENCES holiday(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `holiday` ADD `work_recorded` integer DEFAULT false NOT NULL;