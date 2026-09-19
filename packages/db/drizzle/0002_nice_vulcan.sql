CREATE TABLE `conflict_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`max_cost_delta` real DEFAULT 0 NOT NULL,
	`max_fairness_drop` real DEFAULT 1 NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conflict_policy_unit_id_unique` ON `conflict_policy` (`unit_id`);