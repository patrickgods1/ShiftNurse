CREATE TABLE `overtime_volunteer` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `overtime_volunteer_nurse_start_idx` ON `overtime_volunteer` (`nurse_id`,`start_date`);