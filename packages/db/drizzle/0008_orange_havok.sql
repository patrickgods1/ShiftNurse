CREATE TABLE `setup_state` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`current_step` text,
	`skipped_steps` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
