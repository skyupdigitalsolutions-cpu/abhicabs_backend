-- =========================================================================
-- VEHICLE BOOKING SWITCH
--
-- Two levels, deliberately separate:
--
--   per class   vehicle_catalog.booking_enabled  — "stop taking Innova
--               bookings, every one of them is out until Tuesday"
--   everything  settings['vehicle_booking']      — "stop taking bookings
--               full stop", one switch that does not disturb the per-class
--               state underneath it
--
-- The global switch is a SETTINGS ROW rather than a bulk UPDATE over the
-- catalogue, and that is the important choice here. A bulk update is the
-- obvious implementation and it is one-way: switching everything off and then
-- back on re-enables the three classes that were individually off before, and
-- nobody notices until a rider books a car that is in the workshop. A separate
-- flag leaves the per-class column untouched, so "disable all" is genuinely
-- reversible.
--
-- NOTHING IS DISABLED BY THIS MIGRATION. Every existing class gets
-- booking_enabled = true and the global switch is seeded off, so the
-- behaviour on deploy is identical to today until an admin flips something.
-- =========================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-class switch
-- ---------------------------------------------------------------------------
-- NOT NULL DEFAULT true: every class that exists today is bookable today, and
-- a nullable flag would mean every reader has to decide what NULL means. It
-- means nothing — the column answers a yes/no question.
ALTER TABLE "vehicle_catalog"
  ADD COLUMN IF NOT EXISTS "booking_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "vehicle_catalog"
  ADD COLUMN IF NOT EXISTS "booking_disabled_reason" VARCHAR(200);

ALTER TABLE "vehicle_catalog"
  ADD COLUMN IF NOT EXISTS "booking_disabled_at" TIMESTAMP(3);

-- The fare screen asks for "active AND bookable, in display order" on every
-- quote, which is the hottest read in the system.
CREATE INDEX IF NOT EXISTS "vehicle_catalog_is_active_booking_enabled_sort_order_idx"
  ON "vehicle_catalog" ("is_active", "booking_enabled", "sort_order");

-- ---------------------------------------------------------------------------
-- 2. The settings table
-- ---------------------------------------------------------------------------
-- The Setting model has been in schema.prisma for a while but NO MIGRATION
-- EVER CREATED THE TABLE — which is why src/routes/admin.routes.js wraps every
-- settings read and write in a bare try/catch and falls back to an in-process
-- object. That fallback silently loses the company profile on every restart
-- and does not share it between the API and the worker.
--
-- Created here with IF NOT EXISTS so it is safe whether or not someone has
-- already added the table by hand on a given environment.
CREATE TABLE IF NOT EXISTS "settings" (
  "key"        VARCHAR(64)  NOT NULL,
  "value"      JSONB        NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- ---------------------------------------------------------------------------
-- 3. Seed the global switch, OFF
-- ---------------------------------------------------------------------------
-- Seeded rather than left absent so the admin screen has a row to read and
-- render, instead of having to treat "no row" and "not disabled" as the same
-- thing in three places. ON CONFLICT DO NOTHING keeps a re-run harmless and,
-- more to the point, keeps this migration from switching bookings back ON for
-- anyone who runs it while the switch is engaged.
INSERT INTO "settings" ("key", "value")
VALUES (
  'vehicle_booking',
  '{"allDisabled": false, "reason": null, "disabledAt": null, "disabledBy": null}'::jsonb
)
ON CONFLICT ("key") DO NOTHING;