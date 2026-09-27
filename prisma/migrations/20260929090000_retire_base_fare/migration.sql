-- ---------------------------------------------------------------------------
-- RETIRE THE BASE FARE
-- ---------------------------------------------------------------------------
-- The flat per-trip base fare (Rs 400-1200 depending on class) is no longer
-- part of the product. A fare is now distance x per-km, plus only the charges
-- that represent a real cost: driver allowance (bata), the night allowance,
-- and demand pricing.
--
-- WHY ZERO AND NOT DROP THE COLUMN
-- The fare engine freezes a configSnapshot onto every booking's fareBasis, and
-- `base_fare` is part of that shape. Dropping the column would break the read
-- path for every booking already taken, and would make an old fare dispute
-- unanswerable. Zeroing leaves the rate card reading honestly while the engine
-- (which now hardcodes a zero base) no longer depends on this having been run.
--
-- The default is zeroed too, so a city seeded tomorrow by copying an existing
-- row cannot silently reintroduce a base fare.
-- ---------------------------------------------------------------------------

UPDATE "fare_configs" SET "base_fare" = 0 WHERE "base_fare" <> 0;

ALTER TABLE "fare_configs" ALTER COLUMN "base_fare" SET DEFAULT 0;