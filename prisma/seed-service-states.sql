-- ===========================================================================
-- Seed the four states the fleet currently operates in.
--
-- Alternative to the endpoint, which does the same thing:
--   POST /api/v1/admin/service-states/seed-defaults
--
-- Idempotent. ON CONFLICT DO NOTHING means re-running changes nothing, and in
-- particular will not overwrite aliases an admin has since edited.
--
-- Until this table has an active row, src/lib/serviceArea.js falls back to the
-- built-in four — so the app keeps working before the seed runs. It does not
-- cache that fallback, so the first row you add takes effect immediately.
--
-- ---------------------------------------------------------------------------
-- WHY updated_at IS SET EXPLICITLY
-- ---------------------------------------------------------------------------
-- Prisma's @updatedAt is applied by the CLIENT, not the database. The
-- generated migration therefore creates the column NOT NULL with no DEFAULT,
-- and any INSERT that does not go through Prisma — this one — must supply it
-- or fail on the not-null constraint.
--
-- If you would rather the column looked after itself, the trigger at the
-- bottom of this file makes it true for every writer. Optional.
-- ===========================================================================

INSERT INTO "service_states"
  ("name", "code", "aliases", "is_active", "note", "created_at", "updated_at")
VALUES
  ('Karnataka',      'KA', '["ka","karnatak"]'::jsonb,                               TRUE, 'Seeded default', NOW(), NOW()),
  ('Telangana',      'TG', '["tg","ts","telengana","telangna"]'::jsonb,              TRUE, 'Seeded default', NOW(), NOW()),
  ('Andhra Pradesh', 'AP', '["ap","andhra","andrapradesh","andhrapradhesh"]'::jsonb, TRUE, 'Seeded default', NOW(), NOW()),
  ('Maharashtra',    'MH', '["mh","maharastra","maharashtr","maharashta"]'::jsonb,   TRUE, 'Seeded default', NOW(), NOW())
ON CONFLICT ("name") DO NOTHING;

-- Aliases are stored NORMALISED — lower-case, no spaces or punctuation —
-- because that is how they are compared at match time. Adding "Andhra Pr."
-- here would never match anything; add "andhrapr" instead. The admin endpoint
-- normalises on write, so this only matters for hand-written SQL.

SELECT "id", "name", "code", "aliases", "is_active" FROM "service_states" ORDER BY "name";

-- ===========================================================================
-- OPTIONAL: make updated_at look after itself
-- ===========================================================================
-- Prisma will keep setting the column from the client either way; this just
-- means a row written by psql, a GUI or a future script is also correct
-- instead of failing or going stale.
--
-- CREATE OR REPLACE FUNCTION set_service_states_updated_at()
-- RETURNS TRIGGER AS $$
-- BEGIN
--   NEW."updated_at" = CURRENT_TIMESTAMP;
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
--
-- DROP TRIGGER IF EXISTS service_states_updated_at ON "service_states";
-- CREATE TRIGGER service_states_updated_at
--   BEFORE UPDATE ON "service_states"
--   FOR EACH ROW EXECUTE FUNCTION set_service_states_updated_at();