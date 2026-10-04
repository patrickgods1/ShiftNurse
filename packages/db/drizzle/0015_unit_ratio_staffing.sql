ALTER TABLE `unit` ADD `charge_nurse_takes_patients` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `unit` ADD `break_minutes_per_nurse` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `unit` ADD `charge_covers_breaks` integer DEFAULT false NOT NULL;