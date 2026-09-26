-- A period may only have one budget. setBudget always upserted, but nothing enforced it; keep the
-- row the app has been reading (getBudget takes the first, i.e. lowest rowid) so the unique index
-- below can never fail on an existing database.
DELETE FROM `budget` WHERE rowid NOT IN (SELECT MIN(rowid) FROM `budget` GROUP BY `period_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `budget_period_idx` ON `budget` (`period_id`);--> statement-breakpoint
CREATE INDEX `census_unit_date_idx` ON `census_forecast` (`unit_id`,`date`);--> statement-breakpoint
CREATE INDEX `coverage_unit_idx` ON `coverage_requirement` (`unit_id`);