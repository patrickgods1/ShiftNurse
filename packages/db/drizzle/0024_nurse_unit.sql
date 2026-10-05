CREATE TABLE `nurse_unit` (
	`id` text PRIMARY KEY NOT NULL,
	`nurse_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`competency` text,
	`start_date` text,
	`end_date` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nurse_unit_nurse_unit_idx` ON `nurse_unit` (`nurse_id`,`unit_id`);--> statement-breakpoint
CREATE INDEX `nurse_unit_unit_idx` ON `nurse_unit` (`unit_id`);