CREATE TABLE `availability_block` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`weekdays` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`starts_on` text,
	`ends_on` text,
	`reason` text NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `availability_block_nurse_idx` ON `availability_block` (`nurse_id`);--> statement-breakpoint
CREATE TABLE `float_record` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`date` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`to_unit` text NOT NULL,
	`volunteered` integer NOT NULL,
	`objection` text,
	`actor` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `float_record_unit_date_idx` ON `float_record` (`unit_id`,`date`);--> statement-breakpoint
CREATE TABLE `rest_waiver` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`date` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rest_waiver_nurse_date_idx` ON `rest_waiver` (`nurse_id`,`date`);--> statement-breakpoint
ALTER TABLE `nurse` ADD `permanent_tour` text;--> statement-breakpoint
ALTER TABLE `schedule_change` ADD `consent` text;--> statement-breakpoint
ALTER TABLE `unit` ADD `overtime_order` text;--> statement-breakpoint
ALTER TABLE `unit` ADD `per_diem_commitment` text;--> statement-breakpoint
ALTER TABLE `unit` ADD `require_change_consent` integer;