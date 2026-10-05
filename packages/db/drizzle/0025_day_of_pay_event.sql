CREATE TABLE `day_of_pay_event` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`shift_type_id` text,
	`break_kind` text,
	`scheduled_hours` real,
	`hours_worked` real,
	`note` text,
	`entered_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `day_of_pay_event_unit_date_idx` ON `day_of_pay_event` (`unit_id`,`date`);--> statement-breakpoint
CREATE INDEX `day_of_pay_event_nurse_date_idx` ON `day_of_pay_event` (`nurse_id`,`date`);--> statement-breakpoint
CREATE TABLE `pay_settings` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`call_back_minimum_hours` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
