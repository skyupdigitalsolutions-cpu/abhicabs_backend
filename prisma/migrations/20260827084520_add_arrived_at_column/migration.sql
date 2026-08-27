-- Timestamp for the ARRIVED transition, mirroring confirmed_at / started_at /
-- completed_at. Nullable: only set when the driver marks arrival.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "arrived_at" TIMESTAMP(3);