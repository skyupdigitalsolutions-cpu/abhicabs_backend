-- One-way outstation rates for the 13 models, plus the two luxury cars.
-- Source: the client's one-way rate sheet.
--
-- ASSUMPTIONS MADE HERE, because the sheet gives a per-km rate and nothing
-- else. Each one is a decision, not a fact, and each is cheap to change from
-- the Rate Cards screen:
--
--   base_fare = 0
--       The sheet quotes a flat per-km price. A flagfall on top would make the
--       fare higher than the number the client published.
--
--   minimum_fare = 0
--       No floor. Safe because ONE_WAY is always outstation: quote.service
--       auto-switches a one-way whose drop is inside the city to HOURLY
--       (resolveLocalSwitch), so a 5 km one-way cannot be booked in the first
--       place. Add a floor here if the client wants one.
--
--   return_empty_pct = 0
--       The existing generic cards charge 40% of the return leg. Applying that
--       would bill ~₹27/km on a ₹19/km sedan — far off the published price. The
--       client's rate evidently already accounts for the empty return.
--
--   night_charge_pct = 0, night_allowance = 0
--       The sheet mentions neither. Adding an unstated night markup to a
--       published price is the kind of surprise that produces a refund.
--
--   driver_allowance = 0 on the five non-luxury models
--       The sheet names an allowance ONLY for Fortuner and Mercedes (₹1,000).
--       Silence elsewhere is read as "included".
--
-- NOT COVERED BY ANY SHEET YET: toll and state tax. Every line of the client's
-- sheet says "Toll and state tax extra", and there is no column for it and no
-- code that adds it. Until that is resolved the quoted fare is NOT what the
-- customer finally pays. Either add the fields, or show an explicit
-- "tolls and state tax extra" line on the quote.

/* ------------------------------------------------------------------ *
 * 1. The two luxury cars — catalogue rows
 * ------------------------------------------------------------------ */

INSERT INTO "vehicle_catalog"
  ("key","name","seats","blurb","detail","luggage","glyph","transmission","fuel","sort_order","updated_at")
VALUES
  ('fortuner','Toyota Fortuner',6,
   'Premium SUV, outstation',
   'Chauffeur-driven Fortuner for long-distance travel. Priced per kilometre with a 300 km daily average and a driver allowance.',
   '4 large bags','🚘','Automatic','Diesel',45, CURRENT_TIMESTAMP),

  ('mercedes-e','Mercedes-Benz E-Class',4,
   'Executive saloon, chauffeur driven',
   'The most premium car in the fleet. For weddings, VIP transfers and client travel where the car is part of the impression.',
   '2 large bags','🚘','Automatic','Diesel',46, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;


/* ------------------------------------------------------------------ *
 * 2. ONE_WAY cards for the five cars the sheet prices that way
 * ------------------------------------------------------------------ */

INSERT INTO "fare_configs"
  ("city_id","vehicle_class","trip_type","base_fare","per_km","minimum_fare",
   "return_empty_pct","driver_allowance","night_charge_pct","night_allowance",
   "effective_from")
SELECT c."id", v.vehicle_class, 'ONE_WAY', 0, v.per_km, 0,
       0, 0, 0, 0, TIMESTAMP '2020-01-01 00:00:00'
FROM "cities" c
CROSS JOIN (VALUES
  ('swift-dzire',    19.00),
  ('ertiga',         25.00),
  ('innova',         32.00),
  ('innova-crysta',  35.00),
  ('innova-hycross', 42.00)
) AS v(vehicle_class, per_km)
WHERE NOT EXISTS (
  SELECT 1 FROM "fare_configs" fc
  WHERE fc."city_id" = c."id"
    AND fc."vehicle_class" = v.vehicle_class
    AND fc."trip_type" = 'ONE_WAY'
);


/* ------------------------------------------------------------------ *
 * 3. Luxury outstation — ROUND_TRIP
 * ------------------------------------------------------------------ *
 *
 * "per day 300km average, 1000 driver allowance" is round-trip pricing:
 * min_km_per_day is a ROUND_TRIP-only column, and a daily allowance only means
 * anything on a trip that spans days. A one-way Fortuner is deliberately NOT
 * created — the sheet does not price one, and inventing a rate for a car at
 * ₹55/km is a five-figure guess.
 */

INSERT INTO "fare_configs"
  ("city_id","vehicle_class","trip_type","base_fare","per_km","minimum_fare",
   "min_km_per_day","driver_allowance","return_empty_pct",
   "night_charge_pct","night_allowance","effective_from")
SELECT c."id", v.vehicle_class, 'ROUND_TRIP', 0, v.per_km, 0,
       300, 1000.00, 0, 0, 0, TIMESTAMP '2020-01-01 00:00:00'
FROM "cities" c
CROSS JOIN (VALUES
  ('fortuner',   55.00),
  ('mercedes-e', 95.00)
) AS v(vehicle_class, per_km)
WHERE NOT EXISTS (
  SELECT 1 FROM "fare_configs" fc
  WHERE fc."city_id" = c."id"
    AND fc."vehicle_class" = v.vehicle_class
    AND fc."trip_type" = 'ROUND_TRIP'
);


/* ------------------------------------------------------------------ *
 * 4. Retire the duplicate generic class
 * ------------------------------------------------------------------ *
 *
 * ONLY `sedan`. Its rental package is ₹2,000 for 8 hrs / 80 km — identical to
 * swift-dzire — so the app was listing the same car twice at the same price
 * under two names, which reads as a bug.
 *
 * hatchback, suv, tempo, bus and luxury are LEFT ACTIVE on purpose. They are
 * the only classes with ROUND_TRIP and AIRPORT cards; retiring them before the
 * client supplies per-model rates for those trip types would remove airport
 * and round-trip booking from the app entirely. Retire them from the Rate
 * Cards screen once those rates exist.
 */

UPDATE "vehicle_catalog" SET "is_active" = false, "updated_at" = CURRENT_TIMESTAMP
WHERE "key" = 'sedan';

UPDATE "rental_packages" SET "is_active" = false
WHERE "vehicle_class" = 'sedan';

UPDATE "fare_configs" SET "is_active" = false
WHERE "vehicle_class" = 'sedan';