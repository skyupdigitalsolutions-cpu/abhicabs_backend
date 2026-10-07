-- ---------------------------------------------------------------------------
-- STATEWIDE RATE CARDS
-- ---------------------------------------------------------------------------
--
-- Until now a fare_configs row was always tied to exactly one city, so pricing
-- Karnataka meant creating the same card once per city and re-editing every
-- copy on every price change. Worse, a city opened later started unpriced:
-- getFareConfig threw FARE_CONFIG_MISSING and the rider saw a broken app.
--
-- A card is now scoped either to a CITY or to a STATE:
--
--   scope = 'CITY'    city_id set, prices that city only
--   scope = 'STATE'   state  set, prices EVERY city in that state
--
-- Resolution is most-specific-wins, decided at read time in
-- fareLookup.service: a city card beats a state card for the same
-- (class, trip type). So "same price everywhere in Karnataka, except
-- Bengaluru" is one state card plus one Bengaluru card, and a city opened next
-- month is priced the moment it is created.
--
-- NOTHING IS MATERIALISED. There are no generated per-city copies to keep in
-- sync, which is the whole point: editing the state card changes every city it
-- covers, in one write, with one audit row.
--
-- ---------------------------------------------------------------------------
-- WHY scope_key EXISTS WHEN scope + city_id + state ALREADY SAY IT
-- ---------------------------------------------------------------------------
-- The old uniqueness guarantee was (city_id, vehicle_class, trip_type,
-- effective_from). With city_id now nullable, that constraint stops working
-- for state cards: PostgreSQL treats NULLs as distinct, so ten identical
-- Karnataka cards would all insert cleanly and the quote engine would pick one
-- at random.
--
-- A partial unique index would fix it but cannot be expressed in the Prisma
-- schema, so every future `prisma migrate dev` would generate a DROP for it.
-- scope_key ('city:12' / 'state:karnataka') is a plain column Prisma can hold
-- a real @@unique on, so the guarantee survives in both places.
--
-- It is lower-cased and whitespace-collapsed on write, so "Karnataka" and
-- "karnataka " cannot become two states that price the same cities twice.
-- ---------------------------------------------------------------------------


-- 1. The scope enum. DO block so a re-run or a partially-applied deploy is
--    harmless — CREATE TYPE has no IF NOT EXISTS.
DO $$
BEGIN
  CREATE TYPE "FareScope" AS ENUM ('CITY', 'STATE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;


-- 2. Columns. All nullable/defaulted first so the backfill has somewhere to go.
ALTER TABLE "fare_configs"
  ADD COLUMN IF NOT EXISTS "scope"     "FareScope" NOT NULL DEFAULT 'CITY',
  ADD COLUMN IF NOT EXISTS "state"     VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "scope_key" VARCHAR(96);

ALTER TABLE "fare_configs" ALTER COLUMN "city_id" DROP NOT NULL;


-- 3. Backfill. Every existing row is a city card, which is exactly what it was
--    before — this migration changes no price and no behaviour on its own.
--
--    `state` is copied onto city cards too, denormalised on purpose: the rate
--    card screen filters by state, and doing that through a join on every
--    keystroke is a join the list endpoint does not need.
UPDATE "fare_configs" f
SET "scope_key" = 'city:' || f."city_id",
    "state"     = COALESCE(f."state", c."state")
FROM "cities" c
WHERE c."id" = f."city_id"
  AND f."scope_key" IS NULL;

-- Defensive: an orphan row whose city was deleted would be missed by the join
-- above and then break the NOT NULL below. There should be none (city_id has
-- an FK), but a half-applied earlier attempt could leave one.
UPDATE "fare_configs"
SET "scope_key" = 'city:' || "city_id"
WHERE "scope_key" IS NULL AND "city_id" IS NOT NULL;

ALTER TABLE "fare_configs" ALTER COLUMN "scope_key" SET NOT NULL;


-- 4. Uniqueness moves from city_id to scope_key.
--
--    The explicit short name is deliberate: Prisma's generated name for this
--    index would be 67 characters, past PostgreSQL's 63-byte identifier limit,
--    and a silently truncated name is one that DROP INDEX later misses.
DROP INDEX IF EXISTS "fare_configs_city_id_vehicle_class_trip_type_effective_from_key";

CREATE UNIQUE INDEX IF NOT EXISTS "fare_configs_scope_unique"
  ON "fare_configs" ("scope_key", "vehicle_class", "trip_type", "effective_from");

CREATE INDEX IF NOT EXISTS "fare_configs_state_is_active_idx"
  ON "fare_configs" ("state", "is_active");


-- 5. The shape rule, in the database rather than only in Zod.
--
--    A STATE card with a city_id would be priced by the city lookup AND the
--    state lookup, and which one won would depend on effective_from — i.e. the
--    bug would show up as a price that changes for no visible reason. The
--    check makes that row impossible to write at all, including from psql.
ALTER TABLE "fare_configs" DROP CONSTRAINT IF EXISTS "fare_configs_scope_shape";

ALTER TABLE "fare_configs" ADD CONSTRAINT "fare_configs_scope_shape" CHECK (
  (
    "scope" = 'CITY'
    AND "city_id" IS NOT NULL
    AND "scope_key" = 'city:' || "city_id"
  )
  OR
  (
    "scope" = 'STATE'
    AND "city_id" IS NULL
    AND "state" IS NOT NULL
    -- Must match normaliseState() in fareLookup.service exactly: trim, collapse
    -- internal runs of whitespace to one space, lower-case. If the two ever
    -- drift, every state card insert fails this check rather than quietly
    -- creating a second "Karnataka".
    AND "scope_key" = 'state:' || lower(regexp_replace(btrim("state"), '\s+', ' ', 'g'))
  )
);