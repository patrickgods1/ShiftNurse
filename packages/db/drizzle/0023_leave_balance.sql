CREATE TABLE `fmla_certification` (
	`id` text PRIMARY KEY NOT NULL,
	`nurse_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`intermittent` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fmla_certification_nurse_start_idx` ON `fmla_certification` (`nurse_id`,`start_date`);--> statement-breakpoint
CREATE TABLE `leave_balance` (
	`id` text PRIMARY KEY NOT NULL,
	`nurse_id` text NOT NULL,
	`type` text NOT NULL,
	`balance_hours` real NOT NULL,
	`as_of` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_balance_nurse_type_idx` ON `leave_balance` (`nurse_id`,`type`);