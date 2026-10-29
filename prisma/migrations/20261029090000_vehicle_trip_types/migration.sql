-- ---------------------------------------------------------------------------
-- WHICH VEHICLES MAY BE BOOKED FOR WHICH TRIP TYPES
-- ---------------------------------------------------------------------------
--
-- Today every class with a live rate card for a trip type appears on the fare
-- screen for it. That is the only filter quote.service applies, so an airport
-- transfer offers a 33-seat Benz coach next to a Swift Dzire, and a one-way
-- outstation run offers the 17-seat tempo. Both are bookable, both are priced,
-- and neither is a vehicle the business wants dispatched for that job.
--
-- The requirement is that AIRPORT and ONE_WAY show the sedans, the SUVs and
-- the luxury cars only — and that an admin can widen or narrow that list
-- afterwards without a developer.
--
-- WHY A LIST PER CLASS AND NOT A LIST PER TRIP TYPE
-- The two are the same information. Per class means the rule is edited on the
-- screen that already exists (PATCH /admin/vehicles/:key), next to the seats
-- and the photos, by someone who is already thinking about that vehicle. Per
-- trip type would need a new screen whose only job is four checkbox columns.
--
-- EMPTY MEANS ALL. Every existing row gets '[]' and nothing changes for it.
-- The alternative — backfilling every class with all four trip types — reads
-- identically on day one and then silently excludes any trip type added
-- later, because the lists were written before it existed.
-- ---------------------------------------------------------------------------

ALTER TABLE "vehicle_catalog"
  ADD COLUMN IF NOT EXISTS "trip_types" JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- The coaches come off AIRPORT and ONE_WAY.
-- ---------------------------------------------------------------------------
-- Named explicitly rather than derived from seat count. "More than 13 seats"
-- happens to select the right rows today and is not the rule — the rule is
-- which vehicles the client dispatches for an airport run, and the day a
-- 16-seat Urbania is wanted for a hotel shuttle that is a row an admin
-- changes, not a threshold a developer re-derives.
--
-- ROUND_TRIP and HOURLY are kept: a tempo on a three-day temple tour or an
-- eight-hour city rental is exactly what these vehicles are for.
--
-- Left OFF this list, and therefore unrestricted:
--   swift-dzire, swift-dzire-cng   sedan
--   ertiga, innova, innova-crysta, innova-hycross, fortuner   SUV
--   fortuner, mercedes-e           luxury
UPDATE "vehicle_catalog"
   SET "trip_types" = '["ROUND_TRIP","HOURLY"]'::jsonb,
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "key" IN (
   'tempo-12',
   'tempo-17',
   'urbania-13',
   'urbania-16',
   'urbania-maharaja',
   'benz-22',
   'benz-28',
   'benz-33',
   -- The generic placeholders from the first catalogue pass. Already retired
   -- (is_active = false) but listed so that re-activating one by mistake does
   -- not quietly put "Bus" back on the airport screen.
   'tempo',
   'bus'
 );