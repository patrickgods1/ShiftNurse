-- 0056 gave ratio_rule a tour after 0050's missed-writer guard was written, so a hand edit of only
-- a ratio's tour left no dirty mark and the startup backfill never recorded the version a past
-- date would be judged by. Re-create the update trigger with the tour among the columns it watches.
DROP TRIGGER `ratio_rule_demand_update`;
--> statement-breakpoint
CREATE TRIGGER `ratio_rule_demand_update`
AFTER UPDATE OF `unit_id`, `role`, `acuity_tier_id`, `max_patients_per_nurse`, `citation`, `min_rn_share`, `active`, `tour` ON `ratio_rule`
WHEN OLD.`unit_id` IS NOT NEW.`unit_id`
  OR OLD.`role` IS NOT NEW.`role`
  OR OLD.`acuity_tier_id` IS NOT NEW.`acuity_tier_id`
  OR OLD.`max_patients_per_nurse` IS NOT NEW.`max_patients_per_nurse`
  OR OLD.`citation` IS NOT NEW.`citation`
  OR OLD.`min_rn_share` IS NOT NEW.`min_rn_share`
  OR OLD.`active` IS NOT NEW.`active`
  OR OLD.`tour` IS NOT NEW.`tour`
BEGIN
  INSERT OR IGNORE INTO `demand_config_dirty` (`unit_id`) VALUES (OLD.`unit_id`), (NEW.`unit_id`);
END;
