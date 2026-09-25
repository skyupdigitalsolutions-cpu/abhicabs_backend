-- Retire the generic Sedan and SUV classes from the rider catalogue.
--
-- They are placeholders from the first seed, from before the fleet was
-- modelled car by car (swift-dzire, ertiga, innova, ...). Riders were being
-- offered a "Sedan" and an "SUV" alongside the real cars.
--
-- CATALOGUE ONLY. Their fare_configs and rental_packages are left as they are:
--   * past bookings for these classes still reference them,
--   * they are two of the only four classes with AIRPORT rate cards, and
--     deleting pricing is not something a migration should do silently.
-- quote.service.quoteAllClasses now lists only classes with an ACTIVE
-- catalogue row, so an inactive catalogue row is enough to take a class off
-- every fare screen. Reactivate from the admin Vehicles screen to bring one
-- back.
--
-- Deactivate, never delete: a retired class must still explain the bookings
-- that were made against it.

UPDATE "vehicle_catalog"
SET "is_active" = false,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "key" IN ('sedan', 'suv');