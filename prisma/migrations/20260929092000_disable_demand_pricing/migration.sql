-- ---------------------------------------------------------------------------
-- DISABLE DEMAND PRICING
-- ---------------------------------------------------------------------------
-- No fare carries a surge premium any more. The fare engine already enforces
-- this (clampSurge returns 1 unconditionally), so this migration is not what
-- makes it true — it makes the DATA agree with the engine.
--
-- WHY BOTH
-- The engine is the guarantee: it cannot be bypassed by an admin edit, a
-- hand-run SQL script, or a caller passing its own multiplier. But leaving a
-- 0.5x-2.0x band sitting in the rate card would have ops reading a surge
-- policy that no longer exists, and would quietly re-enable premiums the
-- moment someone deletes the early return in clampSurge without realising the
-- band was still live.
--
-- Pinning both bounds to 1.00 means even that mistake prices at 1x.
--
-- Also neutralises the area-tier surge rules, which are where a multiplier is
-- actually decided (surge.service reads standard_pct / immediate_pct per
-- tier). Zeroing the percentages leaves the tier classification intact for
-- reporting — which areas are busy is still worth knowing — while making the
-- premium it feeds always nil.
--
-- TO RE-ENABLE: restore the bounds and the tier percentages, AND delete the
-- early return in fare.service.clampSurge. Either one alone does nothing.
-- ---------------------------------------------------------------------------

UPDATE "fare_configs"
   SET "min_surge" = 1.00,
       "max_surge" = 1.00
 WHERE "min_surge" <> 1.00
    OR "max_surge" <> 1.00;

ALTER TABLE "fare_configs" ALTER COLUMN "min_surge" SET DEFAULT 1.00;
ALTER TABLE "fare_configs" ALTER COLUMN "max_surge" SET DEFAULT 1.00;

-- Guarded: the surge_rules table arrived with 20260925090000_area_tiers_and_surge.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'surge_rules') THEN
    UPDATE "surge_rules" SET "standard_pct" = 0, "immediate_pct" = 0;
  END IF;
END $$;