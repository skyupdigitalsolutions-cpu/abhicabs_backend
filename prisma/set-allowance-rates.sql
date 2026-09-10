-- ============================================================================
--  set-allowance-rates.sql
--
--  Switches ON the night allowance and the driver allowance (bata) for an
--  EXISTING database, by putting rupee amounts on the rate card.
--
--  This is deliberately NOT part of the schema migration. The migration adds
--  the columns at 0, which charges nothing; this script is the moment prices
--  actually change, so it is a separate step someone has to read and run.
--
--  >>> THESE ARE PLACEHOLDER AMOUNTS. Replace them with ABHICABS' agreed
--  >>> rates before running. They mirror the seed values for Bengaluru.
--
--  Run:  psql "$DATABASE_URL" -f prisma/set-allowance-rates.sql
--
--  Idempotent: it sets absolute values rather than incrementing, so running it
--  twice leaves the same rate card.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Preview what is about to change. Read this before committing.
-- ----------------------------------------------------------------------------
SELECT c."name" AS city, fc."trip_type", fc."vehicle_class",
       fc."driver_allowance" AS bata_now,
       fc."night_allowance"  AS night_now,
       fc."night_charge_pct" AS night_pct_now
FROM "fare_configs" fc
JOIN "cities" c ON c."id" = fc."city_id"
WHERE fc."is_active" = true
ORDER BY c."name", fc."trip_type", fc."vehicle_class";


-- ----------------------------------------------------------------------------
-- ONE_WAY, ROUND_TRIP and HOURLY: bata + flat night allowance, by class.
--
-- AIRPORT is excluded by the WHERE clause. The fare engine exempts it anyway,
-- but leaving a non-zero amount on an airport row would mislead whoever reads
-- the rate card next.
-- ----------------------------------------------------------------------------
UPDATE "fare_configs" fc
   SET "driver_allowance" = r.bata,
       "night_allowance"  = r.night_flat
FROM (VALUES
  ('hatchback', 300.00, 250.00),
  ('sedan',     400.00, 300.00),
  ('suv',       500.00, 400.00),
  ('tempo',     700.00, 500.00)
) AS r(cls, bata, night_flat)
WHERE fc."vehicle_class" = r.cls
  AND fc."trip_type" <> 'AIRPORT'
  AND fc."is_active" = true;


-- ----------------------------------------------------------------------------
-- Make sure every non-airport row is on the 21:55–06:00 window.
-- ----------------------------------------------------------------------------
UPDATE "fare_configs"
   SET "night_start_hour"   = 21,
       "night_start_minute" = 55,
       "night_end_hour"     = 6,
       "night_end_minute"   = 0
 WHERE "trip_type" <> 'AIRPORT'
   AND "is_active" = true;


-- ----------------------------------------------------------------------------
-- Belt and braces: airport rows carry no allowance.
-- ----------------------------------------------------------------------------
UPDATE "fare_configs"
   SET "driver_allowance" = 0,
       "night_allowance"  = 0,
       "night_charge_pct" = 0
 WHERE "trip_type" = 'AIRPORT';


-- ----------------------------------------------------------------------------
-- Result. Confirm this is what you intended, then COMMIT.
-- ----------------------------------------------------------------------------
SELECT c."name" AS city, fc."trip_type", fc."vehicle_class",
       fc."driver_allowance" AS bata,
       fc."night_allowance"  AS night_flat,
       fc."night_charge_pct" AS night_pct,
       fc."night_start_hour" || ':' || LPAD(fc."night_start_minute"::text, 2, '0')
         || '-' ||
       fc."night_end_hour"   || ':' || LPAD(fc."night_end_minute"::text, 2, '0') AS window
FROM "fare_configs" fc
JOIN "cities" c ON c."id" = fc."city_id"
WHERE fc."is_active" = true
ORDER BY c."name", fc."trip_type", fc."vehicle_class";

-- Change to ROLLBACK; if the preview above is not what you expected.
COMMIT;