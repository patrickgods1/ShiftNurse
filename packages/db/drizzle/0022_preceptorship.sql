CREATE TABLE `preceptorship` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`orientee_id` text NOT NULL,
	`preceptor_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`orientee_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preceptor_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `preceptorship_orientee_start_idx` ON `preceptorship` (`orientee_id`,`start_date`);