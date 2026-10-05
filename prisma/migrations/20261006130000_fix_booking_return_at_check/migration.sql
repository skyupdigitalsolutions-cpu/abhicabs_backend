-- ---------------------------------------------------------------------------
-- chk_booking_round_trip_return — make it aware of AIRPORT and HOURLY
-- ---------------------------------------------------------------------------
--
-- THE BUG
--
-- 20260813093904_day1_constraints created this constraint naming two trip
-- types explicitly:
--
--     CHECK (
--       ("trip_type" = 'ONE_WAY'    AND "return_at" IS NULL) OR
--       ("trip_type" = 'ROUND_TRIP' AND "return_at" IS NOT NULL AND ...)
--     )
--
-- A CHECK passes only when the expression is TRUE. An AIRPORT or HOURLY row
-- matches neither branch, so the whole expression is FALSE and Postgres
-- refuses the insert. Both trip types quoted correctly and then failed at the
-- moment of booking with a 500, because nothing before the INSERT touches this
-- rule — the rider saw a confirmed fare and an "Internal server error" on the
-- very next tap.
--
-- WHY A MIGRATION WAS NEEDED AT ALL
--
-- The corrected predicate has existed in prisma/day1-constraints.sql for some
-- time, rewritten as "<> 'ROUND_TRIP'" with a comment describing this exact
-- failure. But that file is a standalone script, not part of the migration
-- chain: `prisma migrate deploy` only runs the folders under
-- prisma/migrations/, so every deploy honestly reported "No pending migrations
-- to apply" while the original predicate stayed on the table. The fix and the
-- database had never met. This migration is what connects them.
--
-- WRITTEN AS <> RATHER THAN NAMING THE OTHER THREE
--
-- Listing ONE_WAY, AIRPORT and HOURLY would work today and reintroduce the bug
-- the next time a trip type is added — which is how it happened the first
-- time. The negative form states the actual rule: a return time belongs to a
-- round trip and to nothing else, whatever products exist later.

-- DROP IF EXISTS, not a bare DROP: a database seeded from day1-constraints.sql
-- rather than from the migration chain already has the corrected version, and
-- this migration must be a no-op there rather than an error that halts deploy.
ALTER TABLE "bookings"
  DROP CONSTRAINT IF EXISTS "chk_booking_round_trip_return";

/*
 * Existing rows are re-validated as the constraint is added, so a single bad
 * row left by an earlier state of the schema would fail this migration. Any
 * AIRPORT or HOURLY booking carrying a return_at is by definition data the old
 * constraint should never have allowed through, so it is cleared first.
 *
 * Scoped to the two trip types and to non-null values only, so it cannot touch
 * a legitimate ROUND_TRIP return. In practice this updates nothing — the old
 * constraint made those rows impossible to insert — but a migration that
 * depends on "in practice" is one that fails at 3am on the one database where
 * it is not true.
 */
UPDATE "bookings"
   SET "return_at" = NULL
 WHERE "trip_type" <> 'ROUND_TRIP'
   AND "return_at" IS NOT NULL;

ALTER TABLE "bookings"
  ADD CONSTRAINT "chk_booking_round_trip_return"
  CHECK (
    ("trip_type" = 'ROUND_TRIP' AND "return_at" IS NOT NULL AND "return_at" > "pickup_at") OR
    ("trip_type" <> 'ROUND_TRIP' AND "return_at" IS NULL)
  );