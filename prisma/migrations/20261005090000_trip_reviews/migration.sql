-- ---------------------------------------------------------------------------
-- TRIP REVIEWS
-- ---------------------------------------------------------------------------
-- A rider's rating and comment for one completed trip.
--
-- WHY A TABLE AND NOT A COLUMN ON bookings
-- drivers.rating_avg / rating_count already exist, but they are an aggregate:
-- they can tell you a driver averages 4.6 and cannot tell you which trip went
-- wrong, what the rider said, or whether a complaint was ever answered. A
-- review is evidence about one journey, and ops need to read the individual
-- rows.
--
-- ONE REVIEW PER BOOKING, enforced by making booking_id the primary key. A
-- rider editing their rating updates the row; there is no history of what they
-- first put, because a rating that can be graded is not the same as one that
-- can be argued over.
--
-- driver_id IS SNAPSHOTTED, not joined through the allocation. Allocations are
-- released when a trip ends and can be reassigned; the review must keep
-- pointing at whoever actually drove. Nullable because a trip can complete
-- without an allocation in the data (older rows, ops-completed trips), and a
-- review of the SERVICE is still worth keeping when the driver is unknown.
--
-- NO NOT-NULL ON comment: most riders rate and say nothing, and forcing an
-- empty string would make "said nothing" indistinguishable from "wrote a
-- space".
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "trip_reviews" (
  "booking_id" UUID PRIMARY KEY,

  -- Who wrote it. Kept even if the booking is later anonymised, because the
  -- review is about the trip, not the person.
  "customer_id" UUID NOT NULL,
  "driver_id"   UUID,

  -- 1 to 5 whole stars. A CHECK rather than trusting the API: a rating outside
  -- the range poisons every average computed from it, silently and forever.
  "rating" SMALLINT NOT NULL,

  "comment" TEXT,

  /*
   * Ops workflow. A one-star review nobody reads is worse than none.
   *   NEW        not looked at
   *   REVIEWED   read, no action needed
   *   ACTIONED   something was done — driver spoken to, refund issued
   */
  "status" VARCHAR(16) NOT NULL DEFAULT 'NEW',
  "admin_note" TEXT,

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "trip_reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5),

  CONSTRAINT "trip_reviews_booking_fk"
    FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE,

  -- RESTRICT, not CASCADE: deleting a customer must not silently erase the
  -- evidence of a complaint about a driver. Account deletion anonymises rather
  -- than deletes (see user.service), so this does not block a rider closing
  -- their account.
  CONSTRAINT "trip_reviews_customer_fk"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("user_id") ON DELETE RESTRICT
);

-- The admin list: newest first, filtered by how bad it is or whether it has
-- been dealt with.
CREATE INDEX IF NOT EXISTS "trip_reviews_status_idx" ON "trip_reviews"("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "trip_reviews_rating_idx" ON "trip_reviews"("rating", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "trip_reviews_driver_idx" ON "trip_reviews"("driver_id", "created_at" DESC);