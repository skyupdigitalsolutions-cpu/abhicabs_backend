-- Minimum fare becomes optional on a rate card.
--
-- Existing rows are untouched: this only changes what an INSERT does when the
-- column is omitted. A card created without a floor bills the computed fare
-- however small it is, which fare.service already handled — it reads the
-- column as `config.minimumFare ?? 0`.
ALTER TABLE "fare_configs" ALTER COLUMN "minimum_fare" SET DEFAULT 0;