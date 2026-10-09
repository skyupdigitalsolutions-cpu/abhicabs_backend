-- ---------------------------------------------------------------------------
-- ROUTE SURGE — a premium on a specific corridor, for a specific window
-- ---------------------------------------------------------------------------
--
-- "Bengaluru to Mysuru, +25%, for the ten days of Dussehra."
--
-- WHY THE EXISTING SURGE CANNOT EXPRESS THIS
-- ---------------------------------------------------------------------------
-- surge_rules is keyed on AreaTier and classified from the PICKUP alone. That
-- is the right shape for what it models — how hard it is to get a car TO a
-- rider — and it is structurally incapable of saying anything about where the
-- rider is going or about what week it is:
--
--   • raising METRO's percentage for Dussehra surcharges every trip leaving
--     Bengaluru, including the airport runs and the city hops that are not
--     busy at all;
--   • it has no date window, so someone has to remember to put it back on the
--     eleventh day, and nothing in the system reminds them;
--   • it cannot distinguish the outbound rush from the quiet return leg.
--
-- So this is a second, independent rule that matches on the CORRIDOR and on
-- WHEN THE TRIP RUNS, and it sits alongside the tier rules rather than
-- replacing them.
--
-- HOW A CORRIDOR IS MATCHED
-- ---------------------------------------------------------------------------
-- Two circles: pickup inside the origin circle AND drop inside the
-- destination circle. Not a polygon, not a road geometry — a corridor is "from
-- roughly here to roughly there", and two centres with radii is something an
-- admin can set from a map and reason about afterwards. Mysuru is a 20 km
-- circle; Bengaluru needs 60 km to catch Whitefield and Electronic City alike.
--
-- Deliberately NOT reusing service_areas as the endpoints. Those radii are
-- tuned for TIER classification, where a small circle must beat a large one so
-- a village is not read as a metro. Borrowing them here would couple two
-- unrelated judgements, and the day someone tightens Mysuru's tier radius the
-- Dussehra surcharge would silently stop matching trips it used to cover.
--
-- WHEN IT APPLIES — THE TRIP DATE, NOT THE BOOKING DATE
-- ---------------------------------------------------------------------------
-- The window is compared against `pickupAt`. A rider booking in August for a
-- Dussehra trip pays the Dussehra rate; a rider booking during Dussehra for a
-- trip in November does not. The premium is for travelling when the road and
-- the fleet are full, which is a fact about the journey, not the purchase.
--
-- HOURLY never matches, with no special case needed: a rental has no
-- destination, so there is nothing for the drop circle to contain.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "surge_routes" (
    "id"   SERIAL      NOT NULL,
    "name" VARCHAR(80) NOT NULL,

    -- The two ends of the corridor.
    "origin_lat"       DECIMAL(10,7) NOT NULL,
    "origin_lng"       DECIMAL(10,7) NOT NULL,
    "origin_radius_km" INTEGER       NOT NULL DEFAULT 25,
    "origin_label"     VARCHAR(80),

    "dest_lat"       DECIMAL(10,7) NOT NULL,
    "dest_lng"       DECIMAL(10,7) NOT NULL,
    "dest_radius_km" INTEGER       NOT NULL DEFAULT 25,
    "dest_label"     VARCHAR(80),

    -- Whether the return leg carries the same premium. Default FALSE: a
    -- festival rush is usually one-directional on any given day, and charging
    -- the empty direction is the kind of thing a customer notices.
    "bidirectional" BOOLEAN NOT NULL DEFAULT false,

    -- The premium, as a percentage of the fare subtotal. Same units as
    -- surge_rules.standard_pct, so the two are directly comparable.
    "pct" DECIMAL(5,2) NOT NULL DEFAULT 0,

    -- The window, compared against the trip's pickup time. Both nullable:
    -- NULL start = "from now", NULL end = "until switched off". A rule with
    -- both NULL is a standing corridor premium, which is legitimate for a
    -- route that is simply always in demand.
    "starts_at" TIMESTAMP(3),
    "ends_at"   TIMESTAMP(3),

    -- Free text for ops: which festival, who approved it, when to review.
    "note" VARCHAR(500),

    "is_active"  BOOLEAN      NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "surge_routes_pkey" PRIMARY KEY ("id")
);

-- The resolver loads every active rule and matches in memory — there are tens
-- of these, not thousands, and a circle test is not something an index helps
-- with. This index serves the admin list and the active-rule load.
CREATE INDEX IF NOT EXISTS "surge_routes_is_active_idx"
    ON "surge_routes"("is_active");

-- A window that ends before it starts matches nothing and is always a typo.
-- Caught here as well as in the validator: the API is not the only thing that
-- can write to this table, as this afternoon demonstrated.
ALTER TABLE "surge_routes"
  DROP CONSTRAINT IF EXISTS "surge_routes_window_order";
ALTER TABLE "surge_routes"
  ADD CONSTRAINT "surge_routes_window_order"
  CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at");

-- A negative premium would be a discount wearing a surge rule's clothes, and
-- every consumer of this number assumes it only ever raises a fare.
ALTER TABLE "surge_routes"
  DROP CONSTRAINT IF EXISTS "surge_routes_pct_range";
ALTER TABLE "surge_routes"
  ADD CONSTRAINT "surge_routes_pct_range"
  CHECK ("pct" >= 0 AND "pct" <= 100);

-- A zero or negative radius is a circle that contains nothing, so the rule
-- would be configured, active, and permanently inert.
ALTER TABLE "surge_routes"
  DROP CONSTRAINT IF EXISTS "surge_routes_radius_positive";
ALTER TABLE "surge_routes"
  ADD CONSTRAINT "surge_routes_radius_positive"
  CHECK ("origin_radius_km" > 0 AND "dest_radius_km" > 0);