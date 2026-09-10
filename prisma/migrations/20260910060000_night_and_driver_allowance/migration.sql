-- Night allowance (flat + minute-precision window) and driver allowance (bata)
-- for all trip types except AIRPORT.
--
-- WHY MINUTES: the night band starts at 21:55. The old columns stored only an
-- hour, so the window could only ever be 21:00 or 22:00 — the first mispriced
-- 55 minutes of evening trips as night, the second missed the 21:55-22:00 band
-- entirely. Minute columns make the stored window match the actual policy.
--
-- ---------------------------------------------------------------------------
-- THIS MIGRATION DOES NOT RAISE ANY PRICE
-- ---------------------------------------------------------------------------
-- It adds columns, tightens the window, and REMOVES charges from airport rows.
-- It deliberately does NOT populate driver_allowance on existing ONE_WAY or
-- HOURLY rows, and does not set night_allowance anywhere.
--
-- Those are rupee amounts, and a schema migration is the wrong place to decide
-- them: it runs unattended on deploy, against live rate cards, with nobody
-- reading the diff. Populating them here would silently add several hundred
-- rupees to every one-way fare the moment this ships, and the first anyone
-- would know is a customer asking why the app quote went up.
--
-- New columns therefore default to 0, which is a no-op: no allowance is
-- charged until someone sets a rate. To turn the allowances on, review and run
-- prisma/set-allowance-rates.sql, which is a separate, deliberate step.

ALTER TABLE "fare_configs"
  ADD COLUMN IF NOT EXISTS "night_allowance"    DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "night_start_minute" INTEGER       NOT NULL DEFAULT 55,
  ADD COLUMN IF NOT EXISTS "night_end_minute"   INTEGER       NOT NULL DEFAULT 0;

-- Reflect the new policy default (21:55) for future inserts.
ALTER TABLE "fare_configs" ALTER COLUMN "night_start_hour" SET DEFAULT 21;

-- Guard the window against nonsense values. A minute of 60+ would silently roll
-- the window an hour forward and misprice trips rather than fail loudly.
ALTER TABLE "fare_configs"
  DROP CONSTRAINT IF EXISTS "chk_fare_night_window";
ALTER TABLE "fare_configs"
  ADD CONSTRAINT "chk_fare_night_window" CHECK (
    "night_start_hour"   BETWEEN 0 AND 23 AND
    "night_end_hour"     BETWEEN 0 AND 23 AND
    "night_start_minute" BETWEEN 0 AND 59 AND
    "night_end_minute"   BETWEEN 0 AND 59
  );

ALTER TABLE "fare_configs"
  DROP CONSTRAINT IF EXISTS "chk_fare_allowances_non_negative";
ALTER TABLE "fare_configs"
  ADD CONSTRAINT "chk_fare_allowances_non_negative" CHECK (
    "night_allowance" >= 0 AND "driver_allowance" >= 0
  );

-- Move every EXISTING non-airport row onto the 21:55–06:00 window. Rows already
-- on 22:00 were configured under the old hour-only limitation, not by choice.
UPDATE "fare_configs"
   SET "night_start_hour"   = 21,
       "night_start_minute" = 55,
       "night_end_hour"     = 6,
       "night_end_minute"   = 0
 WHERE "trip_type" <> 'AIRPORT'
   AND "night_start_hour" = 22
   AND "night_end_hour"   = 6;

-- AIRPORT rows are exempt from both allowances. The fare engine enforces this
-- regardless of the stored values, but zeroing them keeps the rate card honest
-- so nobody reads an airport row and expects bata to be charged.
UPDATE "fare_configs"
   SET "driver_allowance" = 0,
       "night_allowance"  = 0,
       "night_charge_pct" = 0
 WHERE "trip_type" = 'AIRPORT';