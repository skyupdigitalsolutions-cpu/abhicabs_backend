-- ---------------------------------------------------------------------------
-- Retire the last two placeholder classes, and finish pricing the luxury cars.
-- ---------------------------------------------------------------------------
--
-- Found by check-fleet.js against production, which held two catalogue rows the
-- local database did not: 'bus' and 'luxury'.
--
-- 1. 'bus' AND 'luxury' ARE PLACEHOLDERS, NOT VEHICLES
--    Both come from 20260922100000_vehicle_catalog, the first pass at a
--    catalogue, alongside the generic hatchback / sedan / suv / tempo that have
--    since been retired. They were never priced: no rental package and no rate
--    card for any trip type, in any city. A rider selecting one gets
--    FARE_CONFIG_MISSING, so they are pure dead weight on the fleet page.
--    They belong with the other generics.
--
-- 2. THE LUXURY CARS COULD NOT BE RENTED
--    20260930100000 gave fortuner and mercedes-e rental packages, but a
--    package alone cannot be priced: quote.service looks up a HOURLY fare_config
--    by (city, class, HOURLY) BEFORE it reads the package, and throws
--    FARE_CONFIG_MISSING without one. So both had packages that could never be
--    quoted.
--
--    They were also missing ONE_WAY. 20260923120000_oneway_and_luxury added
--    them to its ROUND_TRIP insert but not its ONE_WAY insert, so an outstation
--    one-way in either car has never been bookable.
--
-- The HOURLY cards follow the same shape as every other vehicle's
-- (20260922140000_fleet_models): per_km is the extra-km rate, hourly_rate and
-- minimum_fare are the extra-hour rate, and hourly_km_per_hour is 10.
--
-- ONE_WAY per_km is each car's existing ROUND_TRIP rate, which is what every
-- other vehicle does — one rate for both directions.
--
-- As before: retire by deactivating, never by deleting, so a booking already
-- made against one of these can still explain its own price.
-- ---------------------------------------------------------------------------

/* --- 1. Retire the placeholders ------------------------------------------ */

UPDATE "vehicle_catalog"
SET "is_active" = false,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "key" IN ('bus', 'luxury');

UPDATE "fare_configs"
SET "is_active" = false
WHERE "vehicle_class" IN ('bus', 'luxury');

DELETE FROM "rental_packages"
WHERE "vehicle_class" IN ('bus', 'luxury');

/* --- 2. ONE_WAY for the luxury cars -------------------------------------- */
-- Matches the ONE_WAY cards the other vehicles carry: no base fare, no floor,
-- and a full 100% return leg because the driver comes back empty.

INSERT INTO "fare_configs"
  ("city_id","vehicle_class","trip_type","base_fare","per_km","minimum_fare",
   "return_empty_pct","driver_allowance","night_charge_pct","night_allowance",
   "effective_from")
SELECT c."id", v.cls, 'ONE_WAY', 0, v.per_km, 0,
       100, v.bata, 0, 0, TIMESTAMP '2020-01-01 00:00:00'
FROM "cities" c
CROSS JOIN (VALUES
  -- bata mirrors the ROUND_TRIP cards these two already have, where the
  -- luxury migration set a 1000.00 driver allowance.
  ('fortuner',   55.00, 1000.00),
  ('mercedes-e', 95.00, 1000.00)
) AS v(cls, per_km, bata)
WHERE EXISTS (
  SELECT 1 FROM "vehicle_catalog" vc
  WHERE vc."key" = v.cls AND vc."is_active" = true
)
AND NOT EXISTS (
  SELECT 1 FROM "fare_configs" fc
  WHERE fc."city_id" = c."id"
    AND fc."vehicle_class" = v.cls
    AND fc."trip_type" = 'ONE_WAY'
);

/* --- 3. HOURLY for the luxury cars --------------------------------------- */
-- Without this their rental packages exist but cannot be quoted.

INSERT INTO "fare_configs"
  ("city_id","vehicle_class","trip_type","base_fare","per_km","minimum_fare",
   "hourly_rate","hourly_km_per_hour","effective_from")
SELECT c."id", v.cls, 'HOURLY', 0, v.extra_km, v.extra_hour,
       v.extra_hour, 10, TIMESTAMP '2020-01-01 00:00:00'
FROM "cities" c
CROSS JOIN (VALUES
  ('fortuner',   450.00, 55.00),
  ('mercedes-e', 700.00, 95.00)
) AS v(cls, extra_hour, extra_km)
WHERE EXISTS (
  SELECT 1 FROM "vehicle_catalog" vc
  WHERE vc."key" = v.cls AND vc."is_active" = true
)
AND NOT EXISTS (
  SELECT 1 FROM "fare_configs" fc
  WHERE fc."city_id" = c."id"
    AND fc."vehicle_class" = v.cls
    AND fc."trip_type" = 'HOURLY'
);