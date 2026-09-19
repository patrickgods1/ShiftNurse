CREATE TABLE `shift_swap` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`kind` text NOT NULL,
	`requesting_nurse_id` text NOT NULL,
	`counterparty_nurse_id` text NOT NULL,
	`offered_assignment_id` text NOT NULL,
	`requested_assignment_id` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`entered_by` text DEFAULT 'manager' NOT NULL,
	`submitted_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`reason` text,
	`decision_reason` text,
	`overrode` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`period_id`) REFERENCES `schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requesting_nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`counterparty_nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shift_swap_period_status_idx` ON `shift_swap` (`period_id`,`status`);--> statement-breakpoint
CREATE INDEX `shift_swap_requesting_nurse_idx` ON `shift_swap` (`requesting_nurse_id`);--> statement-breakpoint
CREATE INDEX `shift_swap_counterparty_nurse_idx` ON `shift_swap` (`counterparty_nurse_id`);