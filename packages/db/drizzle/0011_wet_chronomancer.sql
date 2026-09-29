CREATE TABLE `incompatibility_group` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`name` text NOT NULL,
	`max_together` integer DEFAULT 1 NOT NULL,
	`reason` text NOT NULL,
	`starts_on` text,
	`ends_on` text,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `incompatibility_group_unit_idx` ON `incompatibility_group` (`unit_id`);--> statement-breakpoint
CREATE TABLE `incompatibility_member` (
	`group_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `nurse_id`),
	FOREIGN KEY (`group_id`) REFERENCES `incompatibility_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `incompatibility_member_nurse_idx` ON `incompatibility_member` (`nurse_id`);