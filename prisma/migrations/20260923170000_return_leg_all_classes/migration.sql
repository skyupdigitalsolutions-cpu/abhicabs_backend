-- Charge 100% of the return leg on EVERY one-way card, not just the five
-- models from the client's rate sheet.
--
-- The generic classes (hatchback, suv, tempo, sedan, bus, luxury) were seeded
-- at 40% by the Day 1 migration and the earlier scoped UPDATE deliberately
-- left them alone. Deliberate then, wrong now: the client wants one rule.
--
-- No class filter, so a card added later is covered too — but note this also
-- means any future class inherits 100% whether or not its rate was quoted
-- with the return already included.
UPDATE "fare_configs"
SET "return_empty_pct" = 100
WHERE "trip_type" = 'ONE_WAY';