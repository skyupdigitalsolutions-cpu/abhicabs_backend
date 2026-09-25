-- End-of-trip odometer, required from the driver before a trip can complete.
--
-- A separate migration from 20260927090000_start_odometer, not an edit of it:
-- that one may already be applied, and Prisma refuses to run a database whose
-- applied migration no longer matches its file.
--
-- Nullable for the same reasons as the start columns: historic bookings have
-- none, and ops completing a trip from the console are not asked for one.

ALTER TABLE "bookings"
    ADD COLUMN "end_odometer_km"              INTEGER,
    ADD COLUMN "end_odometer_photo_url"       TEXT,
    ADD COLUMN "end_odometer_photo_public_id" VARCHAR(200);

ALTER TABLE "bookings"
    ADD CONSTRAINT "chk_booking_end_odometer_non_negative"
    CHECK ("end_odometer_km" IS NULL OR "end_odometer_km" >= 0);

-- The car cannot finish a trip with fewer km on the clock than it started
-- with. The application checks this first with a readable message; this is
-- the backstop for anything that writes around it.
ALTER TABLE "bookings"
    ADD CONSTRAINT "chk_booking_end_odometer_after_start"
    CHECK (
        "end_odometer_km" IS NULL
        OR "start_odometer_km" IS NULL
        OR "end_odometer_km" >= "start_odometer_km"
    );