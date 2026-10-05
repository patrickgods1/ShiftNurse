CREATE TABLE `leave_bid` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`choices` text NOT NULL,
	`entered_by` text DEFAULT 'manager' NOT NULL,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `leave_bid_round`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leave_bid_round_nurse_idx` ON `leave_bid` (`round_id`,`nurse_id`);--> statement-breakpoint
CREATE TABLE `leave_bid_round` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`name` text NOT NULL,
	`covers_start` text NOT NULL,
	`covers_end` text NOT NULL,
	`opens_on` text NOT NULL,
	`closes_on` text NOT NULL,
	`off_per_day` text NOT NULL,
	`max_awards_per_nurse` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`awarded_at` integer,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `leave_bid_round_unit_idx` ON `leave_bid_round` (`unit_id`);