-- Saved low-census orders gain the float tier (D21): a nurse floated in is borrowed help and goes
-- back before the unit's own staff. It goes after agency where the order has agency, else after
-- volunteer, else first. Each statement skips a row that already lists "float", so re-running
-- changes nothing; tiers are JSON.stringify text, so a plain replace keeps them valid JSON.
UPDATE cancellation_policy SET tiers = replace(tiers, '"agency"', '"agency","float"')
  WHERE instr(tiers, '"float"') = 0 AND instr(tiers, '"agency"') > 0;
--> statement-breakpoint
UPDATE cancellation_policy SET tiers = replace(tiers, '"volunteer"', '"volunteer","float"')
  WHERE instr(tiers, '"float"') = 0 AND instr(tiers, '"volunteer"') > 0;
--> statement-breakpoint
UPDATE cancellation_policy SET tiers = '["float",' || substr(tiers, 2)
  WHERE instr(tiers, '"float"') = 0 AND tiers <> '[]';
