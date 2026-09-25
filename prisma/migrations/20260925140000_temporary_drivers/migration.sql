-- Temporary drivers and hired-in vehicles.
--
-- Both are ordinary rows in the existing tables, flagged. They have to be:
-- allocations.vehicle_id and .driver_id are foreign keys, and the exclusion
-- constraint that prevents double-booking a vehicle is keyed on vehicle_id.
-- Anything living outside those tables could not be dispatched, and would be
-- the only vehicle in the fleet with no overlap protection.
--
-- The flags exist so they can be told apart afterwards: excluded from fleet
-- compliance reports (their papers are the owner's), and countable, so the
-- business can see how often it is running on hired vehicles.

ALTER TABLE "vehicles" ADD COLUMN "is_temporary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "drivers"  ADD COLUMN "is_temporary" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "vehicles_is_temporary_idx" ON "vehicles"("is_temporary");
CREATE INDEX "drivers_is_temporary_idx"  ON "drivers"("is_temporary");