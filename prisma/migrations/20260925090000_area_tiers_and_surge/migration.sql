-- Tiered surge: metro / taluka / village, each with its own urgency pricing.
--
-- REPLACES a single flat rule — 5% on anything inside 30 minutes, everywhere —
-- which priced a village booking the same as a city-centre one despite the
-- supply being nothing alike.

CREATE TYPE "AreaTier" AS ENUM ('METRO', 'TALUKA', 'VILLAGE');

CREATE TABLE "service_areas" (
    "id"         SERIAL        NOT NULL,
    "name"       VARCHAR(80)   NOT NULL,
    "tier"       "AreaTier"    NOT NULL,
    "centre_lat" DECIMAL(10,7) NOT NULL,
    "centre_lng" DECIMAL(10,7) NOT NULL,
    "radius_km"  INTEGER       NOT NULL DEFAULT 15,
    "note"       VARCHAR(500),
    "is_active"  BOOLEAN       NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "service_areas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "service_areas_name_key" ON "service_areas"("name");
CREATE INDEX "service_areas_is_active_idx" ON "service_areas"("is_active");

CREATE TABLE "surge_rules" (
    "id"                       SERIAL       NOT NULL,
    "tier"                     "AreaTier"   NOT NULL,
    "immediate_within_minutes" INTEGER      NOT NULL DEFAULT 60,
    "immediate_pct"            DECIMAL(5,2) NOT NULL DEFAULT 0,
    "standard_pct"             DECIMAL(5,2) NOT NULL DEFAULT 0,
    "is_active"                BOOLEAN      NOT NULL DEFAULT true,
    "updated_at"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "surge_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "surge_rules_tier_key" ON "surge_rules"("tier");

-- The defaults the business asked for. All four numbers are editable from the
-- admin panel afterwards; these are a starting point, not a hardcoded rule.
--
--   METRO    booked within the hour  5%   |  booked earlier   0%
--   TALUKA   booked within the hour 15%   |  booked earlier   5%
--   VILLAGE  booked within the hour 15%   |  booked earlier  10%
--
-- Note the shape: a metro charges for urgency only, while a taluka and a
-- village carry a standing premium because supply is thin at any notice.
INSERT INTO "surge_rules"
  ("tier","immediate_within_minutes","immediate_pct","standard_pct","updated_at")
VALUES
  ('METRO',   60,  5.00,  0.00, CURRENT_TIMESTAMP),
  ('TALUKA',  60, 15.00,  5.00, CURRENT_TIMESTAMP),
  ('VILLAGE', 60, 15.00, 10.00, CURRENT_TIMESTAMP)
ON CONFLICT ("tier") DO NOTHING;

-- Bengaluru as the first area, matching the existing city row so today's
-- behaviour is unchanged on day one. Ops adds talukas and villages from the
-- admin panel; anything unmatched falls back to METRO, which is the cheapest
-- tier — an unclassified place should never overcharge.
INSERT INTO "service_areas"
  ("name","tier","centre_lat","centre_lng","radius_km","note","updated_at")
SELECT c."name", 'METRO', c."centre_lat", c."centre_lng", c."radius_km",
       'Seeded from cities on migration', CURRENT_TIMESTAMP
FROM "cities" c
WHERE NOT EXISTS (SELECT 1 FROM "service_areas" sa WHERE sa."name" = c."name");