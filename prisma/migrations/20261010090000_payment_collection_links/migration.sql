-- prisma/migrations/20261010090000_payment_collection_links/migration.sql
--
-- Payment Links and UPI QR codes: three columns on `payments`.
--
-- All three are NULLABLE with no default and no backfill. Every existing row
-- was an in-app checkout order, and writing 'CHECKOUT' across them would turn
-- an inference into a recorded fact on a money table — the kind of thing that
-- is indistinguishable from evidence a year later when someone is arguing
-- about how a payment was taken. Readers treat null as CHECKOUT instead.
--
-- Adding nullable columns with no default does not rewrite the table, so this
-- takes an ACCESS EXCLUSIVE lock only long enough to update the catalogue.
-- Safe to run against a live deployment.

ALTER TABLE "payments" ADD COLUMN "collection_type" VARCHAR(12);
ALTER TABLE "payments" ADD COLUMN "share_url"       VARCHAR(512);
ALTER TABLE "payments" ADD COLUMN "expires_at"      TIMESTAMP(3);

-- Finding a booking's live link or QR without scanning every payment on it.
-- The existing (booking_id) index cannot serve this: a settled booking can
-- carry an advance, a balance, a refund and several expired links, and the
-- admin screen asks only for the open ones.
CREATE INDEX "payments_booking_id_collection_type_status_idx"
  ON "payments" ("booking_id", "collection_type", "status");

-- NOTE ON THE EXISTING UNIQUE (provider, provider_order_id):
-- Payment Links and QR codes store their OWN id there (plink_… / qr_…), not an
-- order id. That is intentional — see razorpay.provider.js — and the unique
-- constraint keeps doing its job unchanged: one row per gateway instrument,
-- so a replayed webhook can never create a second payment.

-- ---------------------------------------------------------------------------
-- PAYMENT_MANAGE: the permission the new routes are gated by.
--
-- Granted to every role that ALREADY holds PAYMENT_REFUND rather than to
-- everyone with PAYMENT_VIEW. Refunding is moving money out; asking for a
-- payment is moving it in. The same people should do both, and a read-only
-- finance or support role should acquire neither by side effect of this
-- migration.
--
-- Derived from the live table rather than hardcoding role names, so this is
-- correct whatever the role set looks like in a given environment. ON CONFLICT
-- makes it safe to re-run.
-- ---------------------------------------------------------------------------

INSERT INTO "role_permissions" ("role", "permission")
SELECT DISTINCT "role", 'PAYMENT_MANAGE'
FROM "role_permissions"
WHERE "permission" = 'PAYMENT_REFUND'
ON CONFLICT ("role", "permission") DO NOTHING;