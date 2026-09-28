-- ---------------------------------------------------------------------------
-- REMOVE THE AIRPORT SURCHARGE
-- ---------------------------------------------------------------------------
-- An airport transfer is now priced on distance alone. The flat surcharge that
-- covered "airport parking / entry toll" is not charged.
--
-- WHERE IT CAME FROM
-- 20260930100000_real_fleet_only_rentals_airport seeded it when it gave the
-- real fleet their first AIRPORT rate cards: Rs 150 for a hatchback rising to
-- Rs 400 for a 33-seater, on the reasoning that a coach occupies more of the
-- terminal bay. That was my assumption, not a client price, and the client
-- does not charge it.
--
-- WHY ZERO AND NOT DROP THE COLUMN
-- fare.service only renders the "Airport surcharge" line when the value is
-- greater than zero (see the isAirport branch), so zeroing removes the line
-- from every quote and invoice with no code change at all. The column stays so
-- that a booking already taken can still explain a surcharge it was charged,
-- and so reinstating one later is an UPDATE rather than a migration.
--
-- Scoped to AIRPORT rows only. The column is nominally on every rate card, and
-- a blanket UPDATE would silently touch rows where it is already zero and
-- irrelevant — narrower is easier to read back in six months.
-- ---------------------------------------------------------------------------

UPDATE "fare_configs"
   SET "airport_surcharge" = 0
 WHERE "trip_type" = 'AIRPORT'
   AND "airport_surcharge" <> 0;

-- So a rate card added later does not reintroduce one by inheriting the old
-- default.
ALTER TABLE "fare_configs" ALTER COLUMN "airport_surcharge" SET DEFAULT 0;