-- Add the ARRIVED lifecycle state, sequenced between ONGOING and COMPLETED.
-- "Driver has reached the destination; awaiting rider payment before the trip
-- is finalised." Postgres can add an enum value but not position it by default
-- on older versions, so BEFORE 'COMPLETED' keeps the logical ordering tidy.
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'ARRIVED' BEFORE 'COMPLETED';