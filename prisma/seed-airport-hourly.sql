-- ============================================================================
--  seed-airport-hourly.sql
--  Adds AIRPORT and HOURLY fare configs, plus local-rental packages, for
--  Bengaluru — matching the Savaari service model (4hr/40km, 8hr/80km,
--  12hr/120km local rentals; airport transfers with a flat surcharge).
--
--  Run once against your database, e.g.:
--     psql "$DATABASE_URL" -f prisma/seed-airport-hourly.sql
--  or paste into Prisma Studio's SQL runner / your migration.
--
--  Idempotent: guarded with NOT EXISTS, so re-running is safe.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- AIRPORT fares — normal distance fare + a flat airport surcharge (parking,
-- entry toll, queueing). Uses the same base/per-km shape as ONE_WAY.
-- ----------------------------------------------------------------------------
INSERT INTO "fare_configs"
  ("city_id", "vehicle_class", "trip_type", "base_fare", "per_km", "per_minute",
   "minimum_fare", "cancellation_fee", "airport_surcharge",
   "night_charge_pct", "night_start_hour", "night_end_hour", "effective_from")
SELECT c."id", v.cls, 'AIRPORT', v.base, v.km, v.min_rate, v.min_fare, v.cancel, v.surcharge,
       10.00, 22, 6, TIMESTAMPTZ '2020-01-01 00:00:00+00' 
FROM "cities" c
CROSS JOIN (VALUES
  ('hatchback',  350.00, 15.00, 1.50,  550.00,  50.00, 120.00),
  ('sedan',      450.00, 19.00, 2.00,  750.00,  75.00, 150.00),
  ('suv',        650.00, 25.00, 2.50, 1100.00, 100.00, 200.00),
  ('tempo',     1100.00, 33.00, 3.00, 1900.00, 200.00, 250.00)
) AS v(cls, base, km, min_rate, min_fare, cancel, surcharge)
WHERE c."name" = 'Bengaluru'
  AND NOT EXISTS (
    SELECT 1 FROM "fare_configs" fc
    WHERE fc."city_id" = c."id" AND fc."vehicle_class" = v.cls
      AND fc."trip_type" = 'AIRPORT' AND fc."is_active" = true
  );


-- ----------------------------------------------------------------------------
-- HOURLY fares — the FLEXIBLE "any hours" rate used when no fixed package is
-- chosen. Priced as (hours x hourly_rate) + (extra km beyond hours*km_per_hour
-- at per_km). Fixed packages live in rental_packages below.
-- ----------------------------------------------------------------------------
INSERT INTO "fare_configs"
  ("city_id", "vehicle_class", "trip_type", "base_fare", "per_km", "per_minute",
   "minimum_fare", "cancellation_fee",
   "hourly_rate", "hourly_km_per_hour",
   "night_charge_pct", "night_start_hour", "night_end_hour", "effective_from")
SELECT c."id", v.cls, 'HOURLY', 0, v.km, 0, v.min_fare, v.cancel,
       v.hourly, 10, 10.00, 22, 6, TIMESTAMPTZ '2020-01-01 00:00:00+00' 
FROM "cities" c
CROSS JOIN (VALUES
  ('hatchback',  12.00, 200.00,  50.00, 180.00),
  ('sedan',      15.00, 250.00,  75.00, 220.00),
  ('suv',        20.00, 350.00, 100.00, 300.00),
  ('tempo',      28.00, 600.00, 200.00, 500.00)
) AS v(cls, km, min_fare, cancel, hourly)
WHERE c."name" = 'Bengaluru'
  AND NOT EXISTS (
    SELECT 1 FROM "fare_configs" fc
    WHERE fc."city_id" = c."id" AND fc."vehicle_class" = v.cls
      AND fc."trip_type" = 'HOURLY' AND fc."is_active" = true
  );


-- ----------------------------------------------------------------------------
-- RENTAL PACKAGES — the fixed local-rental options (Savaari's 4/40, 8/80,
-- 12/120), one set per vehicle class. Overage beyond included hours/km is
-- charged at extra_per_hour / extra_per_km.
--
-- rental_packages has no unique constraint, so we guard against duplicates with
-- NOT EXISTS (matching city + class + label) instead of ON CONFLICT. Re-running
-- is therefore safe.
-- ----------------------------------------------------------------------------
INSERT INTO "rental_packages"
  ("city_id", "vehicle_class", "label", "included_hours", "included_km",
   "package_fare", "extra_per_hour", "extra_per_km", "sort_order", "is_active")
SELECT c."id", p.cls, p.label, p.hrs, p.km, p.fare, p.xhr, p.xkm, p.sort, true
FROM "cities" c
CROSS JOIN (VALUES
  -- hatchback
  ('hatchback', '4 hrs / 40 km',   4,  40,  900.00,  100.00, 12.00, 1),
  ('hatchback', '8 hrs / 80 km',   8,  80, 1600.00,  100.00, 12.00, 2),
  ('hatchback', '12 hrs / 120 km',12, 120, 2300.00,  100.00, 12.00, 3),
  -- sedan
  ('sedan',     '4 hrs / 40 km',   4,  40, 1100.00,  130.00, 15.00, 1),
  ('sedan',     '8 hrs / 80 km',   8,  80, 2000.00,  130.00, 15.00, 2),
  ('sedan',     '12 hrs / 120 km',12, 120, 2900.00,  130.00, 15.00, 3),
  -- suv
  ('suv',       '4 hrs / 40 km',   4,  40, 1500.00,  180.00, 20.00, 1),
  ('suv',       '8 hrs / 80 km',   8,  80, 2800.00,  180.00, 20.00, 2),
  ('suv',       '12 hrs / 120 km',12, 120, 4000.00,  180.00, 20.00, 3),
  -- tempo
  ('tempo',     '8 hrs / 80 km',   8,  80, 4500.00,  300.00, 28.00, 1),
  ('tempo',     '12 hrs / 120 km',12, 120, 6500.00,  300.00, 28.00, 2)
) AS p(cls, label, hrs, km, fare, xhr, xkm, sort)
WHERE c."name" = 'Bengaluru'
  AND NOT EXISTS (
    SELECT 1 FROM "rental_packages" rp
    WHERE rp."city_id" = c."id"
      AND rp."vehicle_class" = p.cls
      AND rp."label" = p.label
  );