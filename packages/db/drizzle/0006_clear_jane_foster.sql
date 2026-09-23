CREATE TABLE `solver_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`solver_id` text DEFAULT 'hybrid' NOT NULL,
	`max_iterations` integer,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `solver_settings_unit_id_unique` ON `solver_settings` (`unit_id`);