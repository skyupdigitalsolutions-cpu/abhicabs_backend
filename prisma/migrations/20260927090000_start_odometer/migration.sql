-- Start-of-trip odometer, required from the driver before a trip can start.
--
-- The driver enters the reading and photographs the dashboard at pickup; the
-- start call refuses without both. Stored on the booking (not only as a
-- trip_event) so the admin booking detail shows it directly, and so the
-- end-of-trip reading can be validated against it.
--
-- All three nullable: every booking started before this migration has no
-- start reading, and an ops user starting a trip from the console is not
-- asked for one.

ALTER TABLE "bookings"
    ADD COLUMN "start_odometer_km"              INTEGER,
    ADD COLUMN "start_odometer_photo_url"       TEXT,
    ADD COLUMN "start_odometer_photo_public_id" VARCHAR(200);

-- An odometer does not read negative. Enforced here as well as in zod, so a
-- console UPDATE cannot write one either.
ALTER TABLE "bookings"
    ADD CONSTRAINT "chk_booking_start_odometer_non_negative"
    CHECK ("start_odometer_km" IS NULL OR "start_odometer_km" >= 0);