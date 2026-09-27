-- ---------------------------------------------------------------------------
-- SPLIT "SERVICE REACH" FROM "CITY LIMITS"
-- ---------------------------------------------------------------------------
-- cities.radius_km was doing two incompatible jobs at once:
--
--   1. SERVICE REACH  — "will we send a car here?"  Wants to be GENEROUS, so
--      an outskirts pickup is accepted. Bengaluru is set to 60 km for this.
--
--   2. CITY LIMITS    — "is this drop still the same city?"  Wants to be TIGHT,
--      because anything beyond the urban edge is a genuine outstation trip.
--
-- One number cannot be both. With 60 km serving as the city limit, every town
-- around Bengaluru fell "inside" it: Hoskote (25 km), Nelamangala (26 km),
-- Attibele (28 km), Bidadi (30 km), Anekal (31 km), Devanahalli (33 km),
-- Hosur (36 km — a different STATE), Malur (38 km), Magadi (40 km),
-- Ramanagara (44 km), Kanakapura (51 km), Chikkaballapur (54 km).
--
-- A rider booking Bengaluru -> Hosur was therefore told "pickup and drop are in
-- the same city" and silently downgraded to a local rental.
--
-- local_radius_km is the city-limits number. radius_km keeps its original job
-- untouched, so nothing about which pickups are accepted changes here.
--
-- 25 km for Bengaluru covers the BBMP built-up area (Kengeri, Whitefield,
-- Electronic City, Yelahanka all sit inside it) without reaching the ring of
-- satellite towns above.
-- ---------------------------------------------------------------------------

ALTER TABLE "cities"
  ADD COLUMN IF NOT EXISTS "local_radius_km" INTEGER NOT NULL DEFAULT 25;

-- Never wider than the service radius: a "city" larger than the area we serve
-- is meaningless, and it would silently re-widen the same-city test.
UPDATE "cities"
   SET "local_radius_km" = LEAST(25, "radius_km");