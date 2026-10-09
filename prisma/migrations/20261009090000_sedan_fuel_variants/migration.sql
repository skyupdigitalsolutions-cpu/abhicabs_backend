-- ---------------------------------------------------------------------------
-- SEDAN FUEL VARIANTS — Petrol and CNG
-- ---------------------------------------------------------------------------
--
-- The rider can now choose the fuel on the sedan: Swift Dzire Petrol or Swift
-- Dzire CNG. CNG is offered on the sedan ONLY, because that is the only CNG
-- car in the fleet.
--
-- WHY A SECOND vehicleClass AND NOT A FUEL FLAG ON THE BOOKING
-- ---------------------------------------------------------------------------
-- The obvious-looking alternative is one 'swift-dzire' class plus a `fuel`
-- column on bookings. It breaks on the first three questions asked of it:
--
--   PRICE      a rate card is keyed (scope, vehicleClass, tripType). One class
--              means one per-km rate for both fuels — and two fuels at the
--              same price is not why anyone offers CNG.
--   DISPATCH   allocation.service matches vehicle.vehicleClass against
--              booking.vehicleClass exactly. With one class, a rider who asked
--              for CNG gets whichever Dzire is nearest, petrol included, and
--              finds out at pickup.
--   HISTORY    the booking has to still say which car was agreed, years later,
--              on an invoice. The class string already does that everywhere.
--
-- So 'swift-dzire-cng' is a vehicleClass of its own, exactly like every other
-- model on the rate sheet. NO APPLICATION CODE CHANGES ARE NEEDED for it to be
-- quoted, booked, dispatched and invoiced: quote.service, allocation.service
-- and billing.service are all keyed on the class string and have never needed
-- to know what the strings mean.
--
-- The two columns added below are PRESENTATION ONLY. Without them a rider sees
-- two sedan cards with nearly identical names and has to read the fine print
-- to tell them apart; with them the app draws ONE sedan card carrying a
-- Petrol/CNG toggle. Nothing in pricing, dispatch or billing reads them.
-- ---------------------------------------------------------------------------


-- 1. Variant grouping on the catalogue.
--    Nullable, and NULL on every existing row: a class with no variants is
--    untouched, and the API serialises NULL as the row's own key so the app
--    can group unconditionally.
ALTER TABLE "vehicle_catalog"
  ADD COLUMN IF NOT EXISTS "group_key"     VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "variant_label" VARCHAR(24);

CREATE INDEX IF NOT EXISTS "vehicle_catalog_group_key_sort_order_idx"
  ON "vehicle_catalog"("group_key", "sort_order");


-- 2. The existing sedan becomes the PETROL variant.
--    sort_order stays below the CNG row, and that is what makes Petrol the
--    group's title and its preselected toggle — not a hardcoded default in the
--    app, which would have to be edited to change its mind.
UPDATE "vehicle_catalog"
SET "group_key"     = 'swift-dzire',
    "variant_label" = 'Petrol',
    "fuel"          = 'Petrol',
    "sort_order"    = 10,
    "updated_at"    = CURRENT_TIMESTAMP
WHERE "key" = 'swift-dzire';


-- 3. The CNG sedan.
--
--    Luggage is DELIBERATELY one bag fewer than the petrol car. The cylinder
--    sits in the boot and takes most of it; claiming "2 medium bags" here is
--    the kind of small lie a rider discovers with their suitcase already on
--    the pavement. Change it from the admin Vehicles screen if the fleet's
--    cars are fitted differently.
INSERT INTO "vehicle_catalog"
  ("key","name","seats","blurb","detail","luggage","glyph",
   "transmission","fuel","group_key","variant_label","sort_order","updated_at")
VALUES
  ('swift-dzire-cng','Swift Dzire A/C CNG',4,
   'Same sedan, cheaper to run on CNG',
   'BSVI 2024. The same air-conditioned Swift Dzire, running on CNG. Boot space is reduced by the cylinder, so it suits city runs and airport drops with hand luggage rather than a loaded family trip.',
   '1 medium bag','🚗','Manual','CNG','swift-dzire','CNG',11, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;


-- 4. Rate cards, cloned from the petrol sedan.
-- ---------------------------------------------------------------------------
-- A class with no fare_config is a class quote.service cannot price, and
-- quoteAllClasses DROPS it silently — the CNG option would simply never appear
-- on the fare screen, with no error anywhere saying why. So every card the
-- petrol sedan holds (every scope, every trip type, every effective date) gets
-- a twin here.
--
-- The column list is read from information_schema rather than typed out.
-- fare_configs carries over thirty columns and gains more every few migrations
-- (scope_key and minimum_km are both recent); a hardcoded list would clone a
-- sedan that quietly loses whichever column was added last, and the resulting
-- mispricing would look like a fare-engine bug rather than a bad INSERT.
DO $$
DECLARE
  insert_cols text;
  select_cols text;
BEGIN
  -- Two lists built in one pass, in the SAME column order:
  --   insert_cols   "city_id", "vehicle_class", "per_km", ...
  --   select_cols   src."city_id", 'swift-dzire-cng', src."per_km", ...
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position),
         string_agg(
           CASE WHEN column_name = 'vehicle_class'
                THEN quote_literal('swift-dzire-cng')
                ELSE format('src.%I', column_name)
           END, ', ' ORDER BY ordinal_position)
    INTO insert_cols, select_cols
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name   = 'fare_configs'
    AND column_name <> 'id';

  -- Assembled by concatenation rather than a nested dollar-quoted literal. A
  -- $f$...$f$ block inside this $$ block is legal PostgreSQL, but tooling that
  -- splits a migration file into statements by scanning for $$ has been known
  -- to cut it in half, and the deploy box is the worst place to discover that.
  EXECUTE 'INSERT INTO "fare_configs" (' || insert_cols || ') '
       || 'SELECT ' || select_cols || ' FROM "fare_configs" src '
       || 'WHERE src."vehicle_class" = ''swift-dzire'' '
       || '  AND NOT EXISTS ( SELECT 1 FROM "fare_configs" dst '
       || '      WHERE dst."scope_key"      = src."scope_key" '
       || '        AND dst."vehicle_class"  = ''swift-dzire-cng'' '
       || '        AND dst."trip_type"      = src."trip_type" '
       || '        AND dst."effective_from" = src."effective_from" )';
END
$$;


-- 5. Rental packages, cloned the same way.
--    Same reasoning: an HOURLY booking prices from its package, and a class
--    with no package shows the rider an empty rental list rather than an error.
DO $$
DECLARE
  insert_cols text;
  select_cols text;
BEGIN
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position),
         string_agg(
           CASE WHEN column_name = 'vehicle_class'
                THEN quote_literal('swift-dzire-cng')
                ELSE format('src.%I', column_name)
           END, ', ' ORDER BY ordinal_position)
    INTO insert_cols, select_cols
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name   = 'rental_packages'
    AND column_name <> 'id';

  EXECUTE 'INSERT INTO "rental_packages" (' || insert_cols || ') '
       || 'SELECT ' || select_cols || ' FROM "rental_packages" src '
       || 'WHERE src."vehicle_class" = ''swift-dzire'' '
       || '  AND NOT EXISTS ( SELECT 1 FROM "rental_packages" dst '
       || '      WHERE dst."city_id"       = src."city_id" '
       || '        AND dst."vehicle_class" = ''swift-dzire-cng'' '
       || '        AND dst."label"         = src."label" )';
END
$$;


-- 6. PRICING. Cloned at the PETROL price, on purpose.
-- ---------------------------------------------------------------------------
-- This migration will not invent a CNG discount. A rate is a commercial
-- decision and the rate sheet is the client's; a number guessed here would go
-- live as a real price on a real booking.
--
-- Identical pricing is also the safe failure. A rider who picks CNG pays what
-- they would have paid anyway — mildly pointless, visible immediately, fixed
-- in one admin screen. A guessed discount that is too deep is money gone on
-- every CNG trip until someone reconciles the month.
--
-- Set the real rates in the admin Rate Cards screen, or set the factor below
-- and uncomment before deploying. It touches only the three fields a fuel
-- saving actually shows up in; driver allowance and night charges pay the
-- driver and do not get cheaper with the fuel.
--
-- UPDATE "fare_configs"
-- SET "per_km"       = ROUND("per_km"       * 0.90, 2),
--     "hourly_rate"  = ROUND("hourly_rate"  * 0.90, 2),
--     "minimum_fare" = ROUND("minimum_fare" * 0.90, 2)
-- WHERE "vehicle_class" = 'swift-dzire-cng';
--
-- UPDATE "rental_packages"
-- SET "package_fare" = ROUND("package_fare" * 0.90, 2),
--     "extra_per_km" = ROUND("extra_per_km" * 0.90, 2)
-- WHERE "vehicle_class" = 'swift-dzire-cng';


-- 7. NOT DONE HERE: putting actual CNG cars in the fleet.
--
--    allocation.service refuses any vehicle whose class does not equal the
--    booking's, so until at least one row in `vehicles` carries
--    vehicle_class = 'swift-dzire-cng', a CNG booking is quotable and bookable
--    and then cannot be assigned to anybody. Add the cars from the admin Fleet
--    screen (or re-class the CNG Dzires already there) BEFORE this reaches
--    riders.