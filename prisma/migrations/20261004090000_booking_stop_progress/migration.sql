-- ---------------------------------------------------------------------------
-- PER-STOP PROGRESS ON A MULTI-STOP BOOKING
-- ---------------------------------------------------------------------------
-- bookings.stops holds what the rider ASKED FOR: an ordered JSON array of
-- {lat, lng, address}. It records the plan and nothing about what happened.
--
-- So on a three-stop journey the lifecycle had one destination. Status went
-- EN_ROUTE -> REACHED -> ONGOING -> ARRIVED with no notion of reaching stop 2
-- and moving on, no record of when a stop was served, and no waiting time at
-- one. The rider could not see progress and the driver had nothing to mark.
--
-- WHY A TABLE AND NOT MORE JSON
-- These rows are trip EVIDENCE, in the same class as the odometer readings:
-- they answer "when was my second stop served" in a dispute, and "how long did
-- the driver wait" in a fare argument. Evidence wants to be queryable, indexed
-- and individually constrained. A JSON blob mutated on every arrival is none
-- of those, and a concurrent write loses one.
--
-- The plan stays in bookings.stops. This table is progress ONLY, joined by
-- position. Copying addresses here would create a second source of truth for
-- where a stop is, and the two would drift the first time a rider edited a
-- booking.
--
-- NOTHING IS BACKFILLED
-- Existing bookings get no rows. A stop that was never tracked has no arrival
-- time, and inventing one — even a null-filled placeholder — would make
-- untracked look like not-yet-reached. Rows are created when a driver starts
-- the trip, so absence means "this booking predates stop tracking" and the app
-- can say so rather than showing a journey stalled at stop 1.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "booking_stops" (
  "id"         BIGSERIAL PRIMARY KEY,
  "booking_id" UUID NOT NULL,

  -- Zero-based index into bookings.stops. The join key, and the reason the
  -- address is not duplicated here.
  "seq"        INTEGER NOT NULL,

  -- Snapshotted ONLY so a stop can still be named if the booking's JSON is
  -- later edited. Never read in preference to bookings.stops.
  "address"    TEXT,

  "arrived_at"  TIMESTAMP(3),
  "departed_at" TIMESTAMP(3),

  -- Where the driver actually was when they marked it, which is what makes the
  -- record evidence rather than a claim. Null when the device had no fix.
  "arrived_lat" DECIMAL(10,7),
  "arrived_lng" DECIMAL(10,7),

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "booking_stops_booking_fk"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE,

  -- A driver cannot leave a stop before reaching it. Enforced here rather than
  -- only in the service, because a clock skew or a retried request is exactly
  -- how impossible timestamps get written.
  CONSTRAINT "booking_stops_depart_after_arrive"
    CHECK ("departed_at" IS NULL OR "arrived_at" IS NULL OR "departed_at" >= "arrived_at")
);

-- One row per position per booking: a retried "arrive" updates rather than
-- duplicating, which is what makes the endpoint safe to call twice.
CREATE UNIQUE INDEX IF NOT EXISTS "booking_stops_booking_seq_key"
  ON "booking_stops"("booking_id", "seq");

-- The common read: every stop of one booking, in order.
CREATE INDEX IF NOT EXISTS "booking_stops_booking_idx"
  ON "booking_stops"("booking_id", "seq");