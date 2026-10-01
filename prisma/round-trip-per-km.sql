-- ---------------------------------------------------------------------------
-- ROUND-TRIP PER-KM RATES  —  NOT A MIGRATION. RUN BY HAND, ONCE FILLED IN.
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS A SEPARATE FILE AND NOT PART OF THE MIGRATION
--
-- 20261006090000 removed the one-way return-leg charge, so a ONE_WAY card now
-- bills exactly its per_km rate — 19.00/km on a Swift Dzire, matching the
-- published sheet. That half is unambiguous and shipped.
--
-- The other half is a genuine commercial decision: a round trip should price
-- LOWER per kilometre than a one-way, because both legs carry the passenger
-- and the rate does not have to cover an empty return. Today every ROUND_TRIP
-- card still carries the SAME per_km as its ONE_WAY sibling, because
-- 20260923160000 deliberately copied it across.
--
-- The client gave one worked example: Swift Dzire at 19.00 one-way and 12.00
-- round trip. That is the only pair stated. There are fifteen vehicle classes,
-- and the implied 0.63 ratio is an inference from a single data point, not a
-- rule anybody confirmed — applying it to a Mercedes at 95.00/km would invent
-- a number with real money behind it.
--
-- So the migration changes nothing here, and the rates are set deliberately:
-- either from the admin Rate Cards screen (PATCH /admin/fare-configs/:id,
-- audited, cache invalidated automatically), or by filling in and running the
-- block below.
--
-- EITHER WAY, CONFIRM WITH THE CLIENT FIRST. Every row here is a price change.
--
-- ---------------------------------------------------------------------------
-- CURRENT STATE — run this first to see what you are changing
-- ---------------------------------------------------------------------------

SELECT
  fc."vehicle_class",
  MAX(fc."per_km") FILTER (WHERE fc."trip_type" = 'ONE_WAY')    AS one_way_per_km,
  MAX(fc."per_km") FILTER (WHERE fc."trip_type" = 'ROUND_TRIP') AS round_trip_per_km
FROM "fare_configs" fc
WHERE fc."is_active" = true
  AND fc."trip_type" IN ('ONE_WAY','ROUND_TRIP')
GROUP BY fc."vehicle_class"
ORDER BY fc."vehicle_class";

-- ---------------------------------------------------------------------------
-- THE CHANGE — uncomment, fill in every class, then run
-- ---------------------------------------------------------------------------
--
-- Only 'swift-dzire' is filled in, because 12.00 is the one rate the client
-- actually stated. The rest are listed with their CURRENT one-way rate in the
-- comment so there is somewhere obvious to write the agreed figure, and so an
-- unfilled class is visibly unfilled rather than silently defaulted.
--
-- A class left out of this list keeps its existing round-trip rate, which is
-- the safe direction: unchanged pricing, not a guess.
--
-- UPDATE "fare_configs" fc
-- SET "per_km" = v.round_trip_per_km
-- FROM (VALUES
--   --  class              round trip      (current one-way rate, for reference)
--   ('swift-dzire',        12.00),      --  19.00   <- client-confirmed
--   ('ertiga',             NULL),       --  25.00
--   ('innova',             NULL),       --  32.00
--   ('innova-crysta',      NULL),       --  35.00
--   ('innova-hycross',     NULL),       --  42.00
--   ('fortuner',           NULL),       --  55.00
--   ('mercedes-e',         NULL),       --  95.00
--   ('tempo-12',           NULL),       --  41.00
--   ('tempo-17',           NULL),       --  50.00
--   ('urbania-13',         NULL),       --  53.00
--   ('urbania-16',         NULL),       --  60.00
--   ('urbania-maharaja',   NULL),       --  60.00
--   ('benz-22',            NULL),       --  75.00
--   ('benz-28',            NULL),       --  83.00
--   ('benz-33',            NULL)        --  87.00
-- ) AS v(vehicle_class, round_trip_per_km)
-- WHERE fc."vehicle_class" = v.vehicle_class
--   AND fc."trip_type" = 'ROUND_TRIP'
--   AND fc."is_active" = true
--   -- NULL means "not yet agreed" — skip the row rather than write a null rate
--   -- into a NOT NULL column and fail the whole statement halfway through.
--   AND v.round_trip_per_km IS NOT NULL;

-- ---------------------------------------------------------------------------
-- AFTERWARDS
-- ---------------------------------------------------------------------------
--
-- Rate cards are cached for six hours and this writes behind that cache. The
-- admin endpoints invalidate on write; raw SQL does not. So either:
--
--   - make the change from the Rate Cards screen instead (preferred — it also
--     records who changed what in the audit log), or
--   - bump FARE_CFG_CACHE_VERSION in src/services/quote.service.js and deploy,
--     or
--   - flush the `fare:cfg:*` keys from Redis.
--
-- Until one of those happens, /fares/options reads the database directly and
-- shows the NEW price while booking creation prices from the OLD cached row.
-- The rider is quoted one total and charged another.