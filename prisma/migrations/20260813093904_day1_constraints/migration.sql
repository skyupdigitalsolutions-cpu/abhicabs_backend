-- ===========================================================================
-- prisma/day1-constraints.sql
--
-- PASTE THE ENTIRE CONTENTS OF THIS FILE AT THE **END** OF THE GENERATED
-- MIGRATION, then run `npx prisma migrate dev`.
--
--   1. npx prisma migrate dev --name domain --create-only
--   2. open prisma/migrations/<timestamp>_domain/migration.sql
--   3. paste everything below at the very end
--   4. npx prisma migrate dev
--
-- Prisma's schema language cannot express filtered indexes, EXCLUDE
-- constraints, check constraints, or sequences. These are the guarantees that
-- make double-booking and duplicate money PHYSICALLY impossible rather than
-- merely unlikely — do not skip this step.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. VEHICLE DOUBLE-BOOKING GUARD  ← the most important constraint here
--
-- A fleet company legitimately has the same vehicle booked on Monday AND
-- Tuesday, so a plain unique index on vehicle_id would be wrong. What must
-- never happen is two ACTIVE allocations whose time windows OVERLAP.
--
-- A GiST EXCLUDE constraint expresses exactly that: "no two rows where
-- vehicle_id is equal AND the time ranges intersect, among ACTIVE rows".
--
-- The database enforces it, so ten simultaneous allocation attempts on one
-- vehicle produce exactly one winner regardless of application timing.
--
-- NOTE ON tsrange vs tstzrange: Prisma maps `DateTime` to
-- `timestamp(3) without time zone` unless you add @db.Timestamptz. We therefore
-- use tsrange, which matches. Using tstzrange here would force an implicit cast
-- that depends on the session TimeZone — not IMMUTABLE — and Postgres would
-- refuse to create the constraint. If you later switch these columns to
-- timestamptz, change both tsrange calls to tstzrange to match.
--
-- All writes go through Prisma, which normalises JS Dates to UTC, so storage
-- stays consistent. India has no DST, so the practical risk is low.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "allocations"
  ADD CONSTRAINT "excl_allocation_vehicle_overlap"
  EXCLUDE USING gist (
    "vehicle_id" WITH =,
    tsrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" = 'ACTIVE');

-- Same guard for drivers: one driver cannot be on two overlapping trips.
ALTER TABLE "allocations"
  ADD CONSTRAINT "excl_allocation_driver_overlap"
  EXCLUDE USING gist (
    "driver_id" WITH =,
    tsrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" = 'ACTIVE' AND "driver_id" IS NOT NULL);

-- One live allocation per booking. (A released/cancelled allocation may be
-- followed by a new one, which is why this is partial rather than a plain
-- unique constraint.)
CREATE UNIQUE INDEX "uq_allocation_active_booking"
  ON "allocations" ("booking_id")
  WHERE "status" = 'ACTIVE';

-- Windows must be sane.
ALTER TABLE "allocations"
  ADD CONSTRAINT "chk_allocation_window"
  CHECK ("ends_at" > "starts_at");


-- ---------------------------------------------------------------------------
-- 2. ONE OPEN PAYMENT PER PURPOSE PER BOOKING
--
-- A booking may have several payments over its life (advance at booking,
-- balance at completion, a refund). What must not happen is two simultaneous
-- ADVANCE orders for the same booking — that is how a customer gets charged
-- twice. Uniqueness is therefore per (booking, purpose) among live orders.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "uq_payment_open_per_purpose"
  ON "payments" ("booking_id", "purpose")
  WHERE "status" IN ('CREATED', 'AUTHORISED', 'CAPTURED', 'PARTIALLY_PAID');


-- ---------------------------------------------------------------------------
-- 3. MONEY SANITY CHECKS
--
-- Cheap insurance against a bad code path. A constraint you never hit costs
-- nothing; a constraint you did not create costs you a corrupted ledger.
-- ---------------------------------------------------------------------------

ALTER TABLE "bookings"
  ADD CONSTRAINT "chk_booking_amounts_non_negative"
  CHECK (
    "estimated_fare"    >= 0 AND
    "advance_paid"      >= 0 AND
    "balance_due"       >= 0 AND
    "cancellation_fee"  >= 0 AND
    "refund_amount"     >= 0 AND
    ("final_fare" IS NULL OR "final_fare" >= 0)
  );

-- MVAG: the driver receives a minimum share of the fare.
ALTER TABLE "bookings"
  ADD CONSTRAINT "chk_booking_driver_share"
  CHECK ("driver_share_pct" >= 60 AND "driver_share_pct" <= 100);

-- MVAG caps dynamic pricing between 0.5x and 2x the notified base fare.
ALTER TABLE "bookings"
  ADD CONSTRAINT "chk_booking_surge_band"
  CHECK ("surge_multiplier" >= 0.5 AND "surge_multiplier" <= 2.0);

-- A round trip must have a return time, and it must be after pickup.
ALTER TABLE "bookings"
  ADD CONSTRAINT "chk_booking_round_trip_return"
  CHECK (
    ("trip_type" = 'ONE_WAY'    AND "return_at" IS NULL) OR
    ("trip_type" = 'ROUND_TRIP' AND "return_at" IS NOT NULL AND "return_at" > "pickup_at")
  );

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "chk_ledger_amount_positive"
  CHECK ("amount" > 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "chk_payment_amount_positive"
  CHECK ("amount" > 0);

ALTER TABLE "invoices"
  ADD CONSTRAINT "chk_invoice_totals_non_negative"
  CHECK ("subtotal" >= 0 AND "total_amount" >= 0 AND "taxable_value" >= 0);

ALTER TABLE "corporate_accounts"
  ADD CONSTRAINT "chk_corporate_credit"
  CHECK ("credit_limit" >= 0 AND "credit_used" >= 0);


-- ---------------------------------------------------------------------------
-- 4. GAP-FREE INVOICE NUMBERING
--
-- GST requires a continuous series. NEVER derive an invoice number from
-- COUNT(*) — two concurrent invoices would both read the same count and
-- collide, and a deleted row would create a gap.
--
-- A sequence is atomic and monotonic. Usage in code:
--   SELECT nextval('invoice_number_seq');   ->  e.g. 42
--   invoiceNumber = `ABH/${financialYear}/${String(n).padStart(6,'0')}`
--
-- Reset the sequence at the start of each financial year if your series
-- restarts annually.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS "invoice_number_seq" START 1 INCREMENT 1;

-- Same idea for the customer-facing booking reference.
CREATE SEQUENCE IF NOT EXISTS "booking_number_seq" START 1000 INCREMENT 1;


-- ---------------------------------------------------------------------------
-- 5. PARTIAL INDEXES FOR HOT QUERIES
--
-- Far smaller than a full index because they cover only the rows actually
-- queried — the dispatch board scans open bookings, never the completed
-- history.
-- ---------------------------------------------------------------------------

CREATE INDEX "idx_bookings_open"
  ON "bookings" ("pickup_at")
  WHERE "status" IN ('PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE', 'ONGOING');

CREATE INDEX "idx_bookings_unallocated"
  ON "bookings" ("pickup_at")
  WHERE "status" IN ('PENDING', 'CONFIRMED');

CREATE INDEX "idx_vehicles_available"
  ON "vehicles" ("vehicle_class", "city_id")
  WHERE "status" = 'AVAILABLE' AND "is_active" = TRUE;

CREATE INDEX "idx_drivers_online"
  ON "drivers" ("user_id")
  WHERE "is_online" = TRUE AND "kyc_status" = 'VERIFIED';

-- Powers the reconciliation sweeper that hunts for payments stuck in limbo
-- because a webhook never arrived.
CREATE INDEX "idx_payments_pending"
  ON "payments" ("created_at")
  WHERE "status" IN ('CREATED', 'AUTHORISED');

CREATE INDEX "idx_webhooks_unprocessed"
  ON "webhook_events" ("received_at")
  WHERE "processed_at" IS NULL;

CREATE INDEX "idx_attempts_needing_notification"
  ON "booking_attempts" ("created_at")
  WHERE "notified_at" IS NULL;

CREATE INDEX "idx_idempotency_live"
  ON "idempotency_keys" ("expires_at")
  WHERE "status" = 'IN_FLIGHT';

-- Case-insensitive search on customer name/email for the admin console.
CREATE INDEX "idx_users_name_lower" ON "users" (LOWER("name"));


-- ---------------------------------------------------------------------------
-- 6. SEED — Bengaluru, fare configs, RBAC permissions
--
-- Fares below are INDICATIVE placeholders. The state Competent Authority fixes
-- the base fare, and MVAG caps surge between 0.5x and 2x. Replace with the
-- notified figures before launch.
-- ---------------------------------------------------------------------------

INSERT INTO "cities"
  ("name", "state", "centre_lat", "centre_lng", "radius_km", "languages", "welfare_fee_pct")
VALUES
  ('Bengaluru', 'Karnataka', 12.9716000, 77.5946000, 60, '["en","hi","kn"]'::jsonb, 2.00)
ON CONFLICT ("name", "state") DO NOTHING;


-- ONE_WAY fares
INSERT INTO "fare_configs"
  ("city_id", "vehicle_class", "trip_type", "base_fare", "per_km", "per_minute",
   "minimum_fare", "cancellation_fee", "return_empty_pct",
   "night_charge_pct", "night_start_hour", "night_end_hour")
SELECT c."id", v.cls, 'ONE_WAY', v.base, v.km, v.min_rate, v.min_fare, v.cancel, 40.00, 10.00, 22, 6
FROM "cities" c
CROSS JOIN (VALUES
  ('hatchback',  400.00, 14.00, 1.50,  600.00,  50.00),
  ('sedan',      500.00, 18.00, 2.00,  800.00,  75.00),
  ('suv',        700.00, 24.00, 2.50, 1200.00, 100.00),
  ('tempo',     1200.00, 32.00, 3.00, 2000.00, 200.00)
) AS v(cls, base, km, min_rate, min_fare, cancel)
WHERE c."name" = 'Bengaluru'
ON CONFLICT DO NOTHING;


-- ROUND_TRIP fares (min km/day, driver allowance, waiting charges apply)
INSERT INTO "fare_configs"
  ("city_id", "vehicle_class", "trip_type", "base_fare", "per_km", "per_minute",
   "minimum_fare", "cancellation_fee", "min_km_per_day", "driver_allowance",
   "waiting_per_hour", "free_waiting_min",
   "night_charge_pct", "night_start_hour", "night_end_hour")
SELECT c."id", v.cls, 'ROUND_TRIP', v.base, v.km, 0, v.min_fare, v.cancel,
       250, v.bata, v.wait, 30, 10.00, 22, 6
FROM "cities" c
CROSS JOIN (VALUES
  ('hatchback',  400.00, 12.00,  700.00,  50.00, 300.00, 100.00),
  ('sedan',      500.00, 15.00,  900.00,  75.00, 400.00, 120.00),
  ('suv',        700.00, 20.00, 1400.00, 100.00, 500.00, 150.00),
  ('tempo',     1200.00, 28.00, 2400.00, 200.00, 700.00, 200.00)
) AS v(cls, base, km, min_fare, cancel, bata, wait)
WHERE c."name" = 'Bengaluru'
ON CONFLICT DO NOTHING;


-- RBAC: role -> permission map (Day 2 middleware reads this)
INSERT INTO "role_permissions" ("role", "permission") VALUES
  -- ADMIN gets everything
  ('ADMIN', 'USER_MANAGE'),
  ('ADMIN', 'CUSTOMER_MANAGE'),
  ('ADMIN', 'CORPORATE_MANAGE'),
  ('ADMIN', 'BOOKING_CREATE'),
  ('ADMIN', 'BOOKING_MANAGE'),
  ('ADMIN', 'BOOKING_CANCEL'),
  ('ADMIN', 'FARE_EDIT'),
  ('ADMIN', 'DISPATCH_MANAGE'),
  ('ADMIN', 'VEHICLE_MANAGE'),
  ('ADMIN', 'DRIVER_APPROVE'),
  ('ADMIN', 'PAYMENT_VIEW'),
  ('ADMIN', 'PAYMENT_REFUND'),
  ('ADMIN', 'INVOICE_MANAGE'),
  ('ADMIN', 'REPORT_VIEW'),
  ('ADMIN', 'SETTINGS_MANAGE'),
  ('ADMIN', 'AUDIT_VIEW'),

  -- OPS: bookings and dispatch, no money
  ('OPS', 'CUSTOMER_MANAGE'),
  ('OPS', 'BOOKING_CREATE'),
  ('OPS', 'BOOKING_MANAGE'),
  ('OPS', 'BOOKING_CANCEL'),
  ('OPS', 'DISPATCH_MANAGE'),
  ('OPS', 'REPORT_VIEW'),

  -- FINANCE: money and invoices, no dispatch
  ('FINANCE', 'PAYMENT_VIEW'),
  ('FINANCE', 'PAYMENT_REFUND'),
  ('FINANCE', 'INVOICE_MANAGE'),
  ('FINANCE', 'CORPORATE_MANAGE'),
  ('FINANCE', 'REPORT_VIEW'),

  -- FLEET: vehicles and drivers
  ('FLEET', 'VEHICLE_MANAGE'),
  ('FLEET', 'DRIVER_APPROVE'),
  ('FLEET', 'DISPATCH_MANAGE'),
  ('FLEET', 'REPORT_VIEW'),

  -- SUPPORT: read plus cancellation
  ('SUPPORT', 'CUSTOMER_MANAGE'),
  ('SUPPORT', 'BOOKING_MANAGE'),
  ('SUPPORT', 'BOOKING_CANCEL'),
  ('SUPPORT', 'PAYMENT_VIEW'),

  -- Customers and drivers
  ('USER', 'BOOKING_CREATE'),
  ('DRIVER', 'TRIP_MANAGE')
ON CONFLICT ("role", "permission") DO NOTHING;