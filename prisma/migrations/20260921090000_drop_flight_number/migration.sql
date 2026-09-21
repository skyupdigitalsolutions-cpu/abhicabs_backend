-- Drop the AIRPORT flight-number field.
--
-- It was never used by pricing, dispatch or invoicing: nothing read the column
-- back except the booking detail response. Flight tracking was the intent, but
-- no provider was ever wired up, so the field only ever cost the rider a
-- keystroke and us a column.
--
-- IF EXISTS so the migration is safe to re-run and safe on a database where
-- the column was already removed by hand.
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "flight_number";