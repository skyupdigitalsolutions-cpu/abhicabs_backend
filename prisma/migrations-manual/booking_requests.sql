-- ===========================================================================
-- booking_requests — enquiries for routes outside the service states.
--
-- Written by hand because `prisma migrate dev` could not reach the engine
-- download in the environment this was built in. If your machine CAN reach
-- binaries.prisma.sh, prefer the generated migration:
--
--   npx prisma migrate dev --name booking_requests
--
-- and skip this file entirely. Prisma will produce the same DDL and, unlike
-- this script, will record it in _prisma_migrations so future migrations line
-- up. Only run this if the generator is unavailable — and then tell Prisma the
-- state is already applied (see the bottom of this file).
--
-- Adds nothing to existing tables. No existing row is touched.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Status enum
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BookingRequestStatus') THEN
    CREATE TYPE "BookingRequestStatus" AS ENUM (
      'NEW',        -- just submitted, nobody has looked at it
      'REVIEWING',  -- an admin has picked it up
      'QUOTED',     -- a price was sent to the customer, out of band
      'ACCEPTED',   -- converted; see converted_booking_id
      'DECLINED',   -- the fleet cannot serve it
      'CANCELLED'   -- the customer withdrew it
    );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Table
--
-- Coordinates are NULLABLE on purpose. An out-of-area place may never have
-- been geocoded — that is often exactly why it could not be booked — and a NOT
-- NULL lat/lng would reject the enquiries this table exists to capture.
--
-- There are no fare columns at all. Pricing one of these means an admin
-- quoting it by hand; a nullable estimate would only invite the app to show a
-- number nobody stands behind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "booking_requests" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_number" VARCHAR(20) NOT NULL,

  "customer_id" UUID NOT NULL,

  "trip_type"     "TripType" NOT NULL,
  "vehicle_class" VARCHAR(24),

  "pickup_address" TEXT NOT NULL,
  "pickup_lat"     DECIMAL(10,7),
  "pickup_lng"     DECIMAL(10,7),
  "pickup_state"   VARCHAR(64),

  "drop_address" TEXT NOT NULL,
  "drop_lat"     DECIMAL(10,7),
  "drop_lng"     DECIMAL(10,7),
  "drop_state"   VARCHAR(64),

  "pickup_at" TIMESTAMP(3) NOT NULL,
  "return_at" TIMESTAMP(3),

  "passengers" SMALLINT,
  "note"       VARCHAR(500),

  -- Snapshotted at submission. These are worked days later by phone, and a
  -- customer who changes their number meanwhile must not become unreachable.
  "contact_name"  VARCHAR(120),
  "contact_phone" VARCHAR(20),
  "contact_email" VARCHAR(180),

  -- WHY it could not be booked. Stored rather than recomputed, so a request
  -- still explains itself after the allowlist changes.
  "reason" VARCHAR(200),

  "status"     "BookingRequestStatus" NOT NULL DEFAULT 'NEW',
  "admin_note" VARCHAR(1000),

  "handled_by_id" UUID,
  "handled_at"    TIMESTAMP(3),

  "converted_booking_id" UUID,

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- 3. Constraints and indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "booking_requests_request_number_key"
  ON "booking_requests" ("request_number");

-- The ops queue: open requests, oldest first.
CREATE INDEX IF NOT EXISTS "booking_requests_status_created_at_idx"
  ON "booking_requests" ("status", "created_at");

-- "My requests" in the app.
CREATE INDEX IF NOT EXISTS "booking_requests_customer_id_created_at_idx"
  ON "booking_requests" ("customer_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_requests_customer_id_fkey'
  ) THEN
    ALTER TABLE "booking_requests"
      ADD CONSTRAINT "booking_requests_customer_id_fkey"
      FOREIGN KEY ("customer_id") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_requests_handled_by_id_fkey'
  ) THEN
    ALTER TABLE "booking_requests"
      ADD CONSTRAINT "booking_requests_handled_by_id_fkey"
      FOREIGN KEY ("handled_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. updated_at
--
-- Prisma's @updatedAt is applied by the CLIENT, so a row written by psql or by
-- any other tool would keep a stale timestamp. The trigger makes the column
-- true regardless of who wrote the row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_booking_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updated_at" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS booking_requests_updated_at ON "booking_requests";
CREATE TRIGGER booking_requests_updated_at
  BEFORE UPDATE ON "booking_requests"
  FOR EACH ROW EXECUTE FUNCTION set_booking_requests_updated_at();

COMMIT;

-- ===========================================================================
-- AFTERWARDS
-- ===========================================================================
-- 1. Regenerate the client so prisma.bookingRequest exists:
--
--      npx prisma generate
--
-- 2. Tell Prisma this migration is already applied, or the next
--    `migrate dev` will try to create the table again and fail:
--
--      npx prisma migrate resolve --applied <migration_name>
--
--    Alternatively, on a development database with nothing to lose:
--
--      npx prisma db push
--
--    which reconciles the schema without a migration history at all. Do NOT
--    use db push against production — it can drop columns to match.
-- ===========================================================================