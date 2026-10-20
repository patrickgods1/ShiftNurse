ALTER TABLE `unit` ADD `is_home` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `unit_one_home` ON `unit` (`is_home`) WHERE is_home = 1;--> statement-breakpoint
UPDATE unit SET is_home = 1 WHERE rowid = (SELECT min(rowid) FROM unit);
