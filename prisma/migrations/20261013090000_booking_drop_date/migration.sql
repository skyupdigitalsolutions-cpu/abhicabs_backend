-- prisma/migrations/20261013090000_booking_drop_date/migration.sql
--
-- `drop_at`: when a NON-ROUND trip reaches its destination.
--
-- The counterpart to `return_at`, which only a round trip has. Same column
-- type and same storage convention: the rider picks a calendar day and the
-- server pins it to 21:00 in the city's timezone (see lib/returnDate). A
-- second convention for "a date stored as an instant" is how two fields that
-- mean the same shape of thing drift apart.
--
-- Nullable with no default and no backfill. Existing bookings were created
-- before anyone was asked, so there is no honest value to write — and a
-- guessed arrival date is indistinguishable from a stated one once stored.
-- Adding a nullable column with no default does not rewrite the table, so this
-- is safe against a live deployment.

ALTER TABLE "bookings" ADD COLUMN "drop_at" TIMESTAMP(3);

-- Mirrors the existing `return_at > pickup_at` constraint.
--
-- NOT VALID is deliberate: every existing row has drop_at NULL and would pass,
-- but declaring it this way means Postgres skips the full-table scan on ALTER
-- and takes the lock only briefly. New and updated rows are checked from this
-- moment on, which is the whole point. Validate it later at leisure with
--   ALTER TABLE "bookings" VALIDATE CONSTRAINT "chk_booking_drop_after_pickup";
--
-- The 21:00 pinning plus the normaliser's late-pickup clamp is what keeps a
-- legitimate same-day arrival from tripping this.
ALTER TABLE "bookings"
  ADD CONSTRAINT "chk_booking_drop_after_pickup"
  CHECK ("drop_at" IS NULL OR "drop_at" > "pickup_at")
  NOT VALID;

-- A round trip states its end with return_at. Allowing both would leave two
-- fields claiming to say when the trip finishes, and nothing deciding which
-- wins — the service rejects it, and this makes it unrepresentable.
ALTER TABLE "bookings"
  ADD CONSTRAINT "chk_booking_one_end_date"
  CHECK ("drop_at" IS NULL OR "return_at" IS NULL)
  NOT VALID;