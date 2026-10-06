ALTER TABLE `nurse` ADD `scheduled_days_per_week` integer;--> statement-breakpoint
ALTER TABLE `overtime_rule` ADD `pyramiding` text;--> statement-breakpoint
ALTER TABLE `overtime_rule` ADD `minimum_minutes` integer;--> statement-breakpoint
ALTER TABLE `pay_settings` ADD `premium_stacking` text;