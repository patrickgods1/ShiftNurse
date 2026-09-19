-- call_off: drop the foreign key on assignment_id and copy the shift onto the row.
--
-- A backfill replaces the absent nurse's assignment, so the call-off (and its call log) must
-- outlive that row: no FK, and period/nurse/shift/date stored beside the historical id — the
-- same shape `schedule_change` uses. Existing rows are filled from the assignment they still
-- point at (under the old cascade FK no call-off can have outlived its assignment).
--
-- Hand-written rather than the generated table swap. drizzle's migrator runs this whole file
-- inside one transaction, where `PRAGMA foreign_keys=OFF` is silently ignored, so dropping
-- `call_off` while `call_attempt` still references it with ON DELETE CASCADE would fire the
-- implicit DELETE and erase every call log. Rebuilding the child first means the parent is
-- dropped with no children left to cascade into.
CREATE TABLE `__new_call_off` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`period_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`date` text NOT NULL,
	`reported_at` integer NOT NULL,
	`reason` text,
	`status` text DEFAULT 'open' NOT NULL,
	`replacement_assignment_id` text,
	FOREIGN KEY (`period_id`) REFERENCES `schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_call_off`("id", "assignment_id", "period_id", "nurse_id", "shift_type_id", "date", "reported_at", "reason", "status", "replacement_assignment_id")
SELECT c."id", c."assignment_id", a."period_id", a."nurse_id", a."shift_type_id", a."date", c."reported_at", c."reason", c."status", c."replacement_assignment_id"
FROM `call_off` c JOIN `assignment` a ON a."id" = c."assignment_id";--> statement-breakpoint
CREATE TABLE `__new_call_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`call_off_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`attempted_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`notes` text,
	FOREIGN KEY (`call_off_id`) REFERENCES `__new_call_off`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_call_attempt`("id", "call_off_id", "nurse_id", "attempted_at", "outcome", "notes") SELECT "id", "call_off_id", "nurse_id", "attempted_at", "outcome", "notes" FROM `call_attempt`;--> statement-breakpoint
DROP TABLE `call_attempt`;--> statement-breakpoint
DROP TABLE `call_off`;--> statement-breakpoint
ALTER TABLE `__new_call_off` RENAME TO `call_off`;--> statement-breakpoint
ALTER TABLE `__new_call_attempt` RENAME TO `call_attempt`;--> statement-breakpoint
CREATE INDEX `call_off_status_idx` ON `call_off` (`status`);--> statement-breakpoint
CREATE INDEX `call_off_assignment_idx` ON `call_off` (`assignment_id`);--> statement-breakpoint
CREATE INDEX `call_off_period_date_idx` ON `call_off` (`period_id`,`date`);--> statement-breakpoint
CREATE INDEX `call_attempt_calloff_idx` ON `call_attempt` (`call_off_id`);--> statement-breakpoint
CREATE INDEX `call_attempt_nurse_idx` ON `call_attempt` (`nurse_id`,`attempted_at`);
