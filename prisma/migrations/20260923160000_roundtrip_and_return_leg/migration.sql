-- Two changes the client asked for:
--   1. a one-way now charges the FULL return leg (100%, not 0)
--   2. round trips price at the same per-km as one-way

/* ------------------------------------------------------------------ *
 * 1. One-way: charge 100% of the return leg
 * ------------------------------------------------------------------ *
 *
 * The engine already supports this — fare.service computes
 * returnEmptyCharge = pct(distanceCharge, returnEmptyPct) and pushes a
 * "Return journey (100% of distance)" line into the breakdown with the note
 * "Driver returns without a passenger". It was doing nothing only because the
 * column was 0.
 *
 * WHAT THIS DOES TO PRICES: it DOUBLES every one-way fare. Bangalore to Mysuru
 * is ~145 km, so a Swift Dzire at ₹19/km goes from ₹2,755 to ₹5,510.
 *
 * Worth being explicit, because the client's own rate sheet quotes ₹19/km flat
 * with no mention of a return charge. If that ₹19 was ever meant to be the
 * all-in price, this bills every one-way at twice the published rate. Change
 * the value from the Rate Cards screen if so — no migration needed.
 *
 * The percentage applies to the DISTANCE charge only, not the base fare. That
 * is exact today because base_fare is 0 on all of these, but a base fare added
 * later would not be doubled.
 */

UPDATE "fare_configs"
SET "return_empty_pct" = 100
WHERE "trip_type" = 'ONE_WAY'
  AND "vehicle_class" IN (
    'swift-dzire','ertiga','innova','innova-crysta','innova-hycross'
  );


/* ------------------------------------------------------------------ *
 * 2. Round trip at the same per-km as one-way
 * ------------------------------------------------------------------ *
 *
 * No doubling column is needed here and none is added: quote.service already
 * multiplies the route distance by two for a ROUND_TRIP before pricing
 * (`route.distanceKm * 2`), so both legs are billed in full. return_empty_pct
 * is left at 0 BECAUSE of that — fare.service skips the return-leg charge for
 * round trips entirely, and adding it would bill a third leg that does not
 * exist.
 *
 * min_km_per_day = 300
 *   A guess, and the most consequential number here. The client gave no daily
 *   minimum for these thirteen; 300 is their OWN stated convention from the
 *   luxury sheet ("per day 300km average"). Without some minimum, a customer
 *   who keeps a car for three days and drives 50 km pays for 50 km while the
 *   vehicle is off the road for three days.
 *
 * driver_allowance = 0
 *   The sheet names an allowance only for Fortuner and Mercedes (₹1,000).
 *   Silence elsewhere is read as included rather than invented.
 *
 * BOTH are worth confirming with the client before this sees a real customer.
 */

INSERT INTO "fare_configs"
  ("city_id","vehicle_class","trip_type","base_fare","per_km","minimum_fare",
   "min_km_per_day","driver_allowance","return_empty_pct",
   "night_charge_pct","night_allowance","effective_from")
SELECT c."id", v.vehicle_class, 'ROUND_TRIP', 0, v.per_km, 0,
       300, 0, 0, 0, 0, TIMESTAMP '2020-01-01 00:00:00'
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
    AND fc."trip_type" = 'ROUND_TRIP'
);

/*
 * STILL UNPRICED for ONE_WAY and ROUND_TRIP, deliberately:
 *
 *   tempo-12, tempo-17, urbania-13, urbania-16, urbania-maharaja,
 *   benz-22, benz-28, benz-33
 *
 * The client has priced these for LOCAL RENTAL only. There is no one-way rate
 * to copy, so there is nothing to derive a round-trip rate from either, and a
 * per-km figure invented for a 33-seater coach would be a five-figure error on
 * a real invoice. They remain bookable as rentals and will return
 * FARE_CONFIG_MISSING for outstation until the client supplies rates.
 *
 * GET /api/v1/admin/fare-configs/coverage/1 lists the gaps.
 */