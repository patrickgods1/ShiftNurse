-- float_record.shift_type_id: cascade -> no action, like every other history table, so removing a
-- shift type can no longer erase the record that a nurse was floated.
--
-- The generated table swap is safe here, unlike 0005's call_off: the migrator runs this file in one
-- transaction, where PRAGMA foreign_keys=OFF is a no-op, but no table references float_record, so
-- dropping the old table cascades into nothing. Every column is copied and the index recreated.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_float_record` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`nurse_id` text NOT NULL,
	`date` text NOT NULL,
	`shift_type_id` text NOT NULL,
	`to_unit` text NOT NULL,
	`volunteered` integer NOT NULL,
	`objection` text,
	`actor` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `unit`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nurse_id`) REFERENCES `nurse`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_type_id`) REFERENCES `shift_type`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_float_record`("id", "unit_id", "nurse_id", "date", "shift_type_id", "to_unit", "volunteered", "objection", "actor", "at") SELECT "id", "unit_id", "nurse_id", "date", "shift_type_id", "to_unit", "volunteered", "objection", "actor", "at" FROM `float_record`;--> statement-breakpoint
DROP TABLE `float_record`;--> statement-breakpoint
ALTER TABLE `__new_float_record` RENAME TO `float_record`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `float_record_unit_date_idx` ON `float_record` (`unit_id`,`date`);