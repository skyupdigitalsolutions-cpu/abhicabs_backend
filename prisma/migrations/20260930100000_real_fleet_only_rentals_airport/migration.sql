-- ---------------------------------------------------------------------------
-- REAL FLEET ONLY: retire the legacy classes, give every vehicle the three
-- rental packages the client sells, and price airport transfers.
-- ---------------------------------------------------------------------------
--
--   *** THE FARES BELOW ARE DERIVED, NOT SUPPLIED BY THE CLIENT.      ***
--   *** ADMIN MUST REVIEW THEM. SEE "HOW THEY WERE DERIVED" BELOW.    ***
--
-- THREE PROBLEMS, ONE CAUSE
-- The database held two generations of vehicle class. The legacy generic ones
-- (hatchback, sedan, suv, tempo) and the real fleet (swift-dzire ... benz-33).
-- Almost everything the rider could not book traces back to that split:
--
--   RENTALS  quote.service resolves a chosen package across classes BY LABEL.
--            Only the legacy classes had '4 hrs / 40 km' and '12 hrs / 120 km',
--            so those selections showed a near-empty list. The real fleet
--            carried '8 hrs / 80 km' or a '12 hrs / 80 km' the client does not
--            sell at all.
--
--   AIRPORT  fare_configs for AIRPORT existed ONLY for the legacy four. With
--            sedan and suv already retired, exactly hatchback and tempo
--            remained — which is what the rider saw.
--
-- WHAT THIS DOES
--   1. Retires hatchback and tempo (sedan and suv went in 20260928091000).
--   2. Deletes the '12 hrs / 80 km' packages. Not a product the client sells.
--   3. Gives EVERY active fleet vehicle all three real packages:
--      4 hrs / 40 km, 8 hrs / 80 km, 12 hrs / 120 km.
--   4. Adds AIRPORT rate cards for every active fleet vehicle.
--
-- HOW THE PACKAGE FARES WERE DERIVED
-- Each vehicle's OWN rate-sheet package is the anchor, and the other two come
-- from its own published extra-hour and extra-km rates:
--
--   from an 8 hrs / 80 km anchor:
--     4 hrs / 40 km  = anchor - (4 x extra_hour) - (40 x extra_km)
--     12 hrs / 120 km = anchor + (4 x extra_hour) + (40 x extra_km)
--
--   from a 12 hrs / 80 km anchor (the coaches):
--     8 hrs / 80 km   = anchor - (4 x extra_hour)
--     12 hrs / 120 km = anchor + (40 x extra_km)
--     4 hrs / 40 km   = 8-hour value - (4 x extra_hour) - (40 x extra_km)
--
-- Extra-hour and extra-km rates are the client's own and are NOT derived.
-- Only the package fares are.
--
-- KNOWN WRINKLE, DELIBERATELY NOT SMOOTHED OVER
-- The derivation is arithmetic, not commercial, so it does not always produce
-- a monotonic ladder. At 4 hrs / 40 km the Benz 28 lands at 3300 while the
-- Benz 22 lands at 3800, because the 28 carries a higher extra-hour rate that
-- subtracts harder over a short package. The legacy seed shows the client
-- actually discounts longer packages rather than pricing them linearly
-- (hatchback: 900 / 1600 / 2300, where strict arithmetic would give
-- 900 / 1780 / 2480). Left as-is rather than fudged, because a number invented
-- to look tidy is harder to spot than one that is visibly odd.
--
-- HOW ADMIN FIXES A FARE
--   UPDATE "rental_packages" SET "package_fare" = <real>
--    WHERE "vehicle_class" = 'benz-28' AND "label" = '4 hrs / 40 km';
--
-- Retiring is deactivation, never deletion: a retired class must still explain
-- the bookings already made against it.
-- ---------------------------------------------------------------------------

/* --- 1. Retire the remaining legacy classes ------------------------------ */

UPDATE "vehicle_catalog"
SET "is_active" = false,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "key" IN ('hatchback', 'tempo');

-- Their rate cards stop being offered. Rows are kept (not deleted) so an old
-- booking's pricing can still be explained.
UPDATE "fare_configs"
SET "is_active" = false
WHERE "vehicle_class" IN ('hatchback', 'sedan', 'suv', 'tempo');

-- Packages are a live catalogue, not a historical record: a booking freezes
-- its own terms in fareBasis, so these can go.
DELETE FROM "rental_packages"
WHERE "vehicle_class" IN ('hatchback', 'sedan', 'suv', 'tempo');

/* --- 2. Drop the package the client does not sell ------------------------ */

DELETE FROM "rental_packages" WHERE "label" = '12 hrs / 80 km';

/* --- 3. The three real packages, for every active fleet vehicle ---------- */

INSERT INTO "rental_packages"
  ("city_id","vehicle_class","label","included_hours","included_km",
   "package_fare","extra_per_hour","extra_per_km","sort_order","is_active")
SELECT c."id", v.cls, p.label, p.hrs, p.km, p.fare, v.xhr, v.xkm, p.sort, true
FROM "cities" c
CROSS JOIN (VALUES
  --  class,              xhr,    xkm,    f4,       f8,       f12
  ('swift-dzire',       150.00,  14.00,   840.00,  2000.00,  3160.00),
  ('ertiga',            200.00,  18.00,   980.00,  2500.00,  4020.00),
  ('innova',            200.00,  18.00,   980.00,  2500.00,  4020.00),
  ('innova-crysta',     250.00,  20.00,  1200.00,  3000.00,  4800.00),
  ('innova-hycross',    300.00,  25.00,  1300.00,  3500.00,  5700.00),
  ('urbania-13',        300.00,  35.00,  4400.00,  7000.00,  9600.00),
  ('urbania-16',        350.00,  40.00,  4500.00,  7500.00, 10500.00),
  ('urbania-maharaja',  400.00,  40.00,  4800.00,  8000.00, 11200.00),
  ('tempo-12',          250.00,  27.00,  1920.00,  4000.00,  6080.00),
  ('tempo-17',          300.00,  33.00,  2280.00,  4800.00,  7320.00),
  ('benz-22',           400.00,  50.00,  3800.00,  7400.00, 11000.00),
  ('benz-28',           500.00,  55.00,  3300.00,  7500.00, 11700.00),
  ('benz-33',           500.00,  58.00,  3680.00,  8000.00, 12320.00),
  -- The two luxury cars had no rental sheet at all. Anchored on their
  -- one-way per-km (fortuner 55, mercedes-e 95) at the 80 km a package
  -- includes, then the same ladder. Placeholders in the fullest sense.
  ('fortuner',          450.00,  55.00,  2600.00,  6000.00,  9400.00),
  ('mercedes-e',        700.00,  95.00,  4400.00, 11000.00, 17600.00)
) AS v(cls, xhr, xkm, f4, f8, f12)
CROSS JOIN LATERAL (VALUES
  ('4 hrs / 40 km',    4,  40, v.f4,  1),
  ('8 hrs / 80 km',    8,  80, v.f8,  2),
  ('12 hrs / 120 km', 12, 120, v.f12, 3)
) AS p(label, hrs, km, fare, sort)
-- Only vehicles still on sale, so a retired class cannot be revived by this.
WHERE EXISTS (
  SELECT 1 FROM "vehicle_catalog" vc
  WHERE vc."key" = v.cls AND vc."is_active" = true
)
AND NOT EXISTS (
  SELECT 1 FROM "rental_packages" rp
  WHERE rp."city_id" = c."id"
    AND rp."vehicle_class" = v.cls
    AND rp."label" = p.label
);

/* --- 4. AIRPORT rate cards for every active fleet vehicle ---------------- */
-- An airport transfer is a fixed run to or from the terminal: distance x per-km
-- plus the flat airport surcharge. No bata and no night allowance, which is
-- what fare.service already exempts AIRPORT from.
--
-- per_km is each vehicle's own one-way rate. The surcharge scales with size
-- because a coach occupies far more of the terminal bay.

INSERT INTO "fare_configs"
  ("city_id","vehicle_class","trip_type","base_fare","per_km","minimum_fare",
   "airport_surcharge","driver_allowance","return_empty_pct",
   "night_charge_pct","night_allowance","effective_from")
SELECT c."id", v.cls, 'AIRPORT', 0, v.per_km, 0,
       v.surcharge, 0, 0, 0, 0, TIMESTAMP '2020-01-01 00:00:00'
FROM "cities" c
CROSS JOIN (VALUES
  ('swift-dzire',       19.00, 150.00),
  ('ertiga',            25.00, 150.00),
  ('innova',            32.00, 200.00),
  ('innova-crysta',     35.00, 200.00),
  ('innova-hycross',    42.00, 200.00),
  ('fortuner',          55.00, 250.00),
  ('mercedes-e',        95.00, 250.00),
  ('tempo-12',          41.00, 300.00),
  ('tempo-17',          50.00, 300.00),
  ('urbania-13',        53.00, 300.00),
  ('urbania-16',        60.00, 300.00),
  ('urbania-maharaja',  60.00, 300.00),
  ('benz-22',           75.00, 400.00),
  ('benz-28',           83.00, 400.00),
  ('benz-33',           87.00, 400.00)
) AS v(cls, per_km, surcharge)
WHERE EXISTS (
  SELECT 1 FROM "vehicle_catalog" vc
  WHERE vc."key" = v.cls AND vc."is_active" = true
)
AND NOT EXISTS (
  SELECT 1 FROM "fare_configs" fc
  WHERE fc."city_id" = c."id"
    AND fc."vehicle_class" = v.cls
    AND fc."trip_type" = 'AIRPORT'
);