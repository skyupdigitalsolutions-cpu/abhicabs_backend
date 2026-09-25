-- One-way trips charge the FULL return leg (100%), on every rate card.
--
-- WHY THIS RUNS AGAIN
-- -------------------
-- 20260923160000 and 20260923170000 already set return_empty_pct = 100. The
-- live quotes show it back at 0: a hand-run script (disable-time-and-return-
-- charges.sql, not in this repo) zeroed the column afterwards. The engine was
-- never the problem — fare.service charges pct(distance, return_empty_pct)
-- and skips the line entirely at 0, which is exactly what riders saw.
--
-- The earlier migration's comment claimed a card "added later is covered
-- too". It is not: an UPDATE only touches the rows that exist when it runs.
-- New ONE_WAY cards are now defaulted to 100 in fareConfig.service.create,
-- which is what actually covers them.
--
-- WHAT THIS DOES TO PRICES: roughly doubles the distance part of every
-- one-way fare. The 434 km Bengaluru–Hubli Sedan quote goes from ₹8,250 to
-- about ₹16,500. Existing bookings are untouched — each froze its fareBasis.
--
-- ONE_WAY only. The engine never applies the return leg to ROUND_TRIP (that
-- distance is already doubled) and AIRPORT/HOURLY rows are left alone: a 100%
-- return on an airport drop would double the airport fare.
--
-- The fare-config cache key was bumped to v2 in the same deploy
-- (quote.service FARE_CFG_CACHE_VERSION), so booking creation prices from
-- these values immediately rather than from a six-hour-old cached row.

UPDATE "fare_configs"
SET "return_empty_pct" = 100
WHERE "trip_type" = 'ONE_WAY'
  AND "return_empty_pct" <> 100;