-- ---------------------------------------------------------------------------
-- PLACEHOLDER OUTSTATION RATES FOR THE EIGHT LARGE VEHICLES
-- ---------------------------------------------------------------------------
--
--   *** THESE NUMBERS ARE NOT THE CLIENT'S PRICES. ***
--   *** THEY EXIST SO THE VEHICLES ARE BOOKABLE.   ***
--   *** ADMIN MUST OVERWRITE THEM BEFORE LIVE USE. ***
--
-- WHY THESE VEHICLES HAD NO RATES
-- 20260923160000_roundtrip_and_return_leg left tempo-12, tempo-17,
-- urbania-13, urbania-16, urbania-maharaja, benz-22, benz-28 and benz-33
-- unpriced for ONE_WAY and ROUND_TRIP on purpose: the client had priced them
-- for LOCAL RENTAL only. With no fare_config row, quote.service omits them
-- from the fare list entirely and returns FARE_CONFIG_MISSING if one is
-- requested — which is why they could not be booked for outstation.
--
-- HOW THESE PLACEHOLDERS WERE DERIVED
-- From each vehicle's own rental extra-km rate, multiplied by 1.5 and rounded
-- up to the nearest rupee.
--
-- 1.5 is the midpoint of the ratio the REAL rates show on the five cars that
-- have both figures:
--
--   vehicle          rental extra/km   real one-way per/km   ratio
--   swift-dzire            14.00              19.00          1.36
--   ertiga                 18.00              25.00          1.39
--   innova                 18.00              32.00          1.78
--   innova-crysta          20.00              35.00          1.75
--   innova-hycross         25.00              42.00          1.68
--
-- That spread (1.36 to 1.78) is exactly why a formula CANNOT stand in for the
-- real sheet: applied to a 33-seater over 500 km, the difference between the
-- low and high ratio is roughly fourteen thousand rupees on one invoice. These
-- values are a plausible placeholder, nothing more.
--
-- Everything else mirrors the existing cards for the five cars, so these
-- vehicles behave identically to the ones already working:
--   base_fare        0      (retired product-wide)
--   minimum_fare     0      (no floor; ONE_WAY is always outstation)
--   return_empty_pct 100    for ONE_WAY  (driver returns empty — full leg)
--                    0      for ROUND_TRIP (distance is already doubled)
--   min_km_per_day   300    on ROUND_TRIP, matching the other cards
--   driver_allowance 0      night_allowance 0, night_charge_pct 0
--
-- HOW ADMIN REPLACES THEM
-- Through the admin fare-config screens, or directly:
--   UPDATE "fare_configs" SET "per_km" = <real rate>
--    WHERE "vehicle_class" = 'benz-33' AND "trip_type" = 'ONE_WAY';
-- Coverage gaps are listed by GET /api/v1/admin/fare-configs/coverage/:cityId
--
-- Both inserts are guarded by NOT EXISTS, so they never overwrite a rate that
-- is already set — including a real one an admin has already entered.
-- ---------------------------------------------------------------------------

/* ---------------------- ONE_WAY ---------------------- */

INSERT INTO "fare_configs"
  ("city_id","vehicle_class","trip_type","base_fare","per_km","minimum_fare",
   "return_empty_pct","driver_allowance","night_charge_pct","night_allowance",
   "effective_from")
SELECT c."id", v.vehicle_class, 'ONE_WAY', 0, v.per_km, 0,
       100, 0, 0, 0, TIMESTAMP '2020-01-01 00:00:00'
FROM "cities" c
CROSS JOIN (VALUES
  --                    rental extra/km  ->  placeholder (x1.5)
  ('tempo-12',          41.00),  --  27.00
  ('tempo-17',          50.00),  --  33.00
  ('urbania-13',        53.00),  --  35.00
  ('urbania-16',        60.00),  --  40.00
  ('urbania-maharaja',  60.00),  --  40.00
  ('benz-22',           75.00),  --  50.00
  ('benz-28',           83.00),  --  55.00
  ('benz-33',           87.00)   --  58.00
) AS v(vehicle_class, per_km)
WHERE NOT EXISTS (
  SELECT 1 FROM "fare_configs" fc
  WHERE fc."city_id" = c."id"
    AND fc."vehicle_class" = v.vehicle_class
    AND fc."trip_type" = 'ONE_WAY'
);

/* ---------------------- ROUND_TRIP ---------------------- */
-- Same per-km. On the five priced cars the client charges one rate for both,
-- and inventing a second, lower round-trip rate would be a second guess on top
-- of the first.

INSERT INTO "fare_configs"
  ("city_id","vehicle_class","trip_type","base_fare","per_km","minimum_fare",
   "min_km_per_day","driver_allowance","return_empty_pct",
   "night_charge_pct","night_allowance","effective_from")
SELECT c."id", v.vehicle_class, 'ROUND_TRIP', 0, v.per_km, 0,
       300, 0, 0, 0, 0, TIMESTAMP '2020-01-01 00:00:00'
FROM "cities" c
CROSS JOIN (VALUES
  ('tempo-12',          41.00),
  ('tempo-17',          50.00),
  ('urbania-13',        53.00),
  ('urbania-16',        60.00),
  ('urbania-maharaja',  60.00),
  ('benz-22',           75.00),
  ('benz-28',           83.00),
  ('benz-33',           87.00)
) AS v(vehicle_class, per_km)
WHERE NOT EXISTS (
  SELECT 1 FROM "fare_configs" fc
  WHERE fc."city_id" = c."id"
    AND fc."vehicle_class" = v.vehicle_class
    AND fc."trip_type" = 'ROUND_TRIP'
);