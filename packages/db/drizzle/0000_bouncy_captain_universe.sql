CREATE TABLE `acuity_tier` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`name` text NOT NULL,
	`level` integer NOT NULL,
	`care_hours_per_patient_day` real NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`period_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`date` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`is_locked` integer DEFAULT false NOT NULL,
	`is_charge` integer DEFAULT false NOT NULL,
	`is_overtime` integer DEFAULT false NOT NULL,
	`notes` text,
	FOREIGN KEY (`period_id`) REFERENCES `schedule_period`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assignment_period_date_idx` ON `assignment` (`period_id`,`date`);--> statement-breakpoint
CREATE INDEX `assignment_nurse_date_idx` ON `assignment` (`nurse_id`,`date`);--> statement-breakpoint
CREATE INDEX `assignment_shift_idx` ON `assignment` (`date`,`shift_type_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assignment_unique_idx` ON `assignment` (`nurse_id`,`date`,`shift_type_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`before` text,
	`after` text,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `budget` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`period_id` text NOT NULL,
	`target_dollars` real NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`period_id`) REFERENCES `schedule_period`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `call_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`call_off_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`attempted_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`notes` text,
	FOREIGN KEY (`call_off_id`) REFERENCES `call_off`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `call_attempt_calloff_idx` ON `call_attempt` (`call_off_id`);--> statement-breakpoint
CREATE INDEX `call_attempt_nurse_idx` ON `call_attempt` (`nurse_id`,`attempted_at`);--> statement-breakpoint
CREATE TABLE `call_off` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`reported_at` integer NOT NULL,
	`reason` text,
	`status` text DEFAULT 'open' NOT NULL,
	`replacement_assignment_id` text,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `call_off_status_idx` ON `call_off` (`status`);--> statement-breakpoint
CREATE TABLE `census_forecast` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`date` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`projected_census` integer NOT NULL,
	`acuity_mix` text NOT NULL,
	`actual_census` integer,
	`actual_acuity_mix` text,
	`source` text DEFAULT 'manual' NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `census_date_shift_idx` ON `census_forecast` (`date`,`shift_type_id`);--> statement-breakpoint
CREATE TABLE `coverage_requirement` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`weekday` integer,
	`date` text,
	`role` text NOT NULL,
	`min_count` integer NOT NULL,
	`target_count` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `coverage_lookup_idx` ON `coverage_requirement` (`shift_type_id`,`role`,`weekday`);--> statement-breakpoint
CREATE TABLE `credential` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`tracks_expiry` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_code_unique` ON `credential` (`code`);--> statement-breakpoint
CREATE TABLE `differential` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`kind` text NOT NULL,
	`mode` text NOT NULL,
	`amount` real NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fairness_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`nurse_id` text NOT NULL,
	`period_id` text NOT NULL,
	`period_start` text NOT NULL,
	`night_shifts` integer DEFAULT 0 NOT NULL,
	`weekends_worked` integer DEFAULT 0 NOT NULL,
	`holidays_worked` integer DEFAULT 0 NOT NULL,
	`on_call_shifts` integer DEFAULT 0 NOT NULL,
	`undesirable_shifts` integer DEFAULT 0 NOT NULL,
	`requests_approved` integer DEFAULT 0 NOT NULL,
	`requests_denied` integer DEFAULT 0 NOT NULL,
	`call_outs_covered` integer DEFAULT 0 NOT NULL,
	`total_hours` real DEFAULT 0 NOT NULL,
	`overtime_hours` real DEFAULT 0 NOT NULL,
	`preference_hit_rate` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fairness_nurse_period_idx` ON `fairness_ledger` (`nurse_id`,`period_id`);--> statement-breakpoint
CREATE INDEX `fairness_window_idx` ON `fairness_ledger` (`nurse_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `holiday` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`date` text NOT NULL,
	`name` text NOT NULL,
	`is_major` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holiday_unit_date_idx` ON `holiday` (`unit_id`,`date`);--> statement-breakpoint
CREATE TABLE `hppd_target` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`target_hours` real NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `nurse` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`role` text NOT NULL,
	`employment_type` text NOT NULL,
	`fte` real NOT NULL,
	`contracted_hours_per_period` real NOT NULL,
	`seniority_date` text NOT NULL,
	`is_charge_eligible` integer DEFAULT false NOT NULL,
	`is_novice` integer DEFAULT false NOT NULL,
	`is_float_eligible` integer DEFAULT true NOT NULL,
	`phone` text,
	`email` text,
	`active` integer DEFAULT true NOT NULL,
	`notes` text,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nurse_employee_id_idx` ON `nurse` (`unit_id`,`employee_id`);--> statement-breakpoint
CREATE INDEX `nurse_unit_active_idx` ON `nurse` (`unit_id`,`active`);--> statement-breakpoint
CREATE INDEX `nurse_seniority_idx` ON `nurse` (`unit_id`,`seniority_date`);--> statement-breakpoint
CREATE TABLE `nurse_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`nurse_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`issued_on` text,
	`expires_on` text,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credential`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nurse_credential_unique_idx` ON `nurse_credential` (`nurse_id`,`credential_id`);--> statement-breakpoint
CREATE INDEX `nurse_credential_expiry_idx` ON `nurse_credential` (`expires_on`);--> statement-breakpoint
CREATE TABLE `overtime_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`basis` text NOT NULL,
	`threshold_hours` real NOT NULL,
	`multiplier` real NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pay_rate` (
	`id` text PRIMARY KEY NOT NULL,
	`nurse_id` text,
	`role` text,
	`hourly_rate` real NOT NULL,
	`effective_from` text NOT NULL,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pay_rate_lookup_idx` ON `pay_rate` (`nurse_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `preference` (
	`id` text PRIMARY KEY NOT NULL,
	`nurse_id` text NOT NULL,
	`kind` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`shift_type_id` text,
	`weekday` integer,
	`level` real,
	`block_shifts` integer,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `preference_nurse_idx` ON `preference` (`nurse_id`);--> statement-breakpoint
CREATE TABLE `ratio_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`role` text NOT NULL,
	`acuity_tier_id` text,
	`max_patients_per_nurse` real NOT NULL,
	`citation` text,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`acuity_tier_id`) REFERENCES `acuity_tier`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ratio_rule_unit_idx` ON `ratio_rule` (`unit_id`,`active`);--> statement-breakpoint
CREATE TABLE `rule_config` (
	`rule_set_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`severity_override` text,
	`params` text NOT NULL,
	PRIMARY KEY(`rule_set_id`, `rule_id`),
	FOREIGN KEY (`rule_set_id`) REFERENCES `rule_set`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rule_set` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`weekend_definition` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_set_version_idx` ON `rule_set` (`unit_id`,`version`);--> statement-breakpoint
CREATE TABLE `schedule_period` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` integer,
	`rule_set_id` text NOT NULL,
	`rule_set_version` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_set_id`) REFERENCES `rule_set`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `period_unit_range_idx` ON `schedule_period` (`unit_id`,`start_date`,`end_date`);--> statement-breakpoint
CREATE TABLE `shift_credential_requirement` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`shift_type_id` text,
	`role` text,
	`credential_id` text NOT NULL,
	`min_count` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credential`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shift_cred_req_unit_idx` ON `shift_credential_requirement` (`unit_id`);--> statement-breakpoint
CREATE TABLE `shift_type` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`name` text NOT NULL,
	`abbreviation` text NOT NULL,
	`start_time` text NOT NULL,
	`duration_hours` real NOT NULL,
	`is_night` integer DEFAULT false NOT NULL,
	`is_on_call` integer DEFAULT false NOT NULL,
	`color` text DEFAULT '#64748b' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shift_type_unit_idx` ON `shift_type` (`unit_id`);--> statement-breakpoint
CREATE TABLE `time_off_request` (
	`id` text PRIMARY KEY NOT NULL,
	`nurse_id` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`entered_by` text DEFAULT 'manager' NOT NULL,
	`submitted_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`reason` text,
	`decision_reason` text,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `time_off_nurse_idx` ON `time_off_request` (`nurse_id`);--> statement-breakpoint
CREATE INDEX `time_off_range_idx` ON `time_off_request` (`start_date`,`end_date`);--> statement-breakpoint
CREATE INDEX `time_off_status_idx` ON `time_off_request` (`status`);--> statement-breakpoint
CREATE TABLE `unit` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`unit_type` text NOT NULL,
	`pay_period_days` integer NOT NULL,
	`pay_period_anchor` text NOT NULL
);
