-- prisma/migrations/20261017090000_standalone_payment_collections/migration.sql
--
-- Payment links and QR codes that belong to NO booking.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES, AND WHY IT IS SAFE ON A LIVE TABLE
-- ---------------------------------------------------------------------------
-- 1. booking_id becomes NULLABLE. Dropping NOT NULL is a catalogue-only change
--    in Postgres: no table rewrite, no row touched, an ACCESS EXCLUSIVE lock
--    held for microseconds. Every existing row keeps its booking.
--
-- 2. Four nullable columns with no default, which also do not rewrite the
--    table. They are null on every booking-scoped payment, which is correct
--    rather than missing data: that payer is derived from the booking.
--
-- 3. Two indexes, built with the ordinary (blocking) CREATE INDEX because the
--    payments table is small. If this runs against a table with millions of
--    rows, switch both to CREATE INDEX CONCURRENTLY and run them outside the
--    migration transaction — Prisma wraps migrations, and CONCURRENTLY cannot
--    run inside one.
--
-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE
-- ---------------------------------------------------------------------------
-- uq_payment_open_per_purpose is UNIQUE (booking_id, purpose) WHERE the status
-- is live. Postgres treats NULLs as distinct in a unique index, so any number
-- of standalone collections can be open at once while the guarantee that
-- matters — one open ADVANCE per real booking — is untouched. This is the
-- reason standalone rows can share the payments table at all.
--
-- The unique (provider, provider_order_id) also stands: a standalone link
-- stores its own plink_/qr_ id there exactly as a booking-scoped one does, so
-- a replayed webhook still cannot create a second row.

-- ---------------------------------------------------------------------------
-- 1. A payment need not belong to a booking
-- ---------------------------------------------------------------------------

ALTER TABLE "payments" ALTER COLUMN "booking_id" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Who is being asked, when there is no booking to ask it of
-- ---------------------------------------------------------------------------

ALTER TABLE "payments" ADD COLUMN "payer_name"  VARCHAR(120);
ALTER TABLE "payments" ADD COLUMN "payer_phone" VARCHAR(20);
ALTER TABLE "payments" ADD COLUMN "payer_email" VARCHAR(160);
ALTER TABLE "payments" ADD COLUMN "description" VARCHAR(500);

-- ---------------------------------------------------------------------------
-- 3. The two lookups the standalone screen needs
-- ---------------------------------------------------------------------------

-- The standalone collections list. The existing
-- (booking_id, collection_type, status) index cannot serve it: booking_id is
-- null on every row it returns, and a null leading column is not a usable
-- prefix for an equality scan on the rest.
CREATE INDEX "payments_collection_type_status_created_at_idx"
  ON "payments" ("collection_type", "status", "created_at" DESC);

-- "Have we already sent this number a link?" — for a customer who does not
-- exist in `users` yet, the phone number is the only handle anyone has.
CREATE INDEX "payments_payer_phone_idx"
  ON "payments" ("payer_phone")
  WHERE "payer_phone" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. A standalone collection must name its payer
--
-- Enforced in the database, not only in Zod, because the alternative is a
-- captured payment with no booking and no payer — money in the account that
-- nobody can attribute to a person. A phone number is the minimum that makes
-- a standalone row reconcilable, and it is also what the WhatsApp share and
-- Razorpay's own SMS delivery both need.
--
-- NOT VALID so the statement does not scan the existing table; every current
-- row has a booking_id and therefore satisfies it trivially. Validated
-- immediately afterwards under a weaker SHARE UPDATE EXCLUSIVE lock.
-- ---------------------------------------------------------------------------

ALTER TABLE "payments"
  ADD CONSTRAINT "chk_payment_booking_or_payer"
  CHECK ("booking_id" IS NOT NULL OR "payer_phone" IS NOT NULL)
  NOT VALID;

ALTER TABLE "payments" VALIDATE CONSTRAINT "chk_payment_booking_or_payer";