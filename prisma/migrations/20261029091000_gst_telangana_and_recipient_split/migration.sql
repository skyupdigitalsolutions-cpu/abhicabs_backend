-- ---------------------------------------------------------------------------
-- THE TELANGANA REGISTRATION, WHICH WAS NEVER SEEDED
-- ---------------------------------------------------------------------------
--
-- 20261001090000_gst_config seeded two rows: Karnataka and MAHARASHTRA. The
-- client holds Karnataka and TELANGANA. The switching logic has been correct
-- all along — gst.service.resolveConfig picks the registration by pickup
-- state, exactly as the requirement asks — it has simply had nothing to switch
-- to.
--
-- WHAT THAT LOOKED LIKE IN PRODUCTION
-- A corporate booking picked up in Hyderabad found no row for Telangana, so
-- resolveRate returned NO_TAX, the fare screen showed no GST, and
-- billing.service downgraded the document to NON_TAX with a null
-- seller_gstin. A bill of supply, for a taxable B2B supply, with no
-- registration on it. Nothing errored and nothing logged.
--
-- WHY MAHARASHTRA IS DEACTIVATED AND NOT DELETED
-- It is a placeholder GSTIN for a state the client is not registered in, so
-- leaving it active means a Mumbai pickup would raise a tax invoice under a
-- fictional number. Deactivating is the documented way to retire a
-- registration (see the is_active comment on the table): the row stays, so
-- anything ever issued under it can still explain itself, and gst_config_state
-- _active_key is partial precisely so a retired row never blocks a
-- replacement.
--
-- Guarded on the placeholder GSTIN. If someone has already replaced it with a
-- real Maharashtra number, this touches nothing.
--
-- ===========================================================================
--  !! THE GSTINs BELOW ARE PLACEHOLDERS IN THE CORRECT FORMAT !!
--  Replace BOTH with the real registrations before issuing a single invoice:
--      PATCH /api/v1/admin/gst-configs/:id   { "gstin": "29ABCDE1234F1Z5" }
--  36 = Telangana, 29 = Karnataka.
-- ===========================================================================
-- ---------------------------------------------------------------------------

/* --- 1. Retire the placeholder Maharashtra registration ------------------ */

UPDATE "gst_config"
   SET "is_active"  = false,
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "state" = 'Maharashtra'
   AND "gstin" = '27AAAAA0000A1Z5';

/* --- 2. Add Telangana ---------------------------------------------------- */
-- Defaults deliberately MATCH the live Karnataka row rather than the column
-- defaults, so the two registrations behave identically: corporate-only,
-- tax added on top of the fare, all four trip types taxed. A second
-- registration that quietly taxed differently from the first would be a
-- reconciliation problem nobody would look for.

INSERT INTO "gst_config"
  ("state", "district", "gstin", "legal_name",
   "rate_pct", "is_inclusive",
   "apply_retail", "apply_corporate",
   "apply_one_way", "apply_round_trip", "apply_airport", "apply_hourly",
   "interstate_by_route", "hsn_sac", "is_active")
SELECT 'Telangana', NULL, '36AAAAA0000A1Z5', 'AbhiCabs',
       18.00, false,
       false, true,
       true, true, true, true,
       false, '9964', true
WHERE NOT EXISTS (
  SELECT 1 FROM "gst_config" g WHERE g."state" = 'Telangana' AND g."is_active"
);

/* --- 3. Split by the recipient's own GSTIN (opt-in) ---------------------- */
-- See the schema comment. OFF by default and it should stay off until a CA
-- signs it off: for passenger transport the place of supply is where the
-- passenger embarks, which makes the pickup state the answer and every trip
-- intra-state. The flag exists so that a client holding two registrations can
-- have the behaviour changed in the admin panel rather than in a service.

ALTER TABLE "gst_config"
  ADD COLUMN IF NOT EXISTS "split_by_recipient_gstin" BOOLEAN NOT NULL DEFAULT false;

/* --- 4. Keep place of supply honest on the booking ----------------------- */
-- billing.service.createInvoice reads booking.pickupState and
-- booking.dropState and neither is a column on `bookings` — they only exist
-- on booking_requests. BILLING_SELECT even carries a comment explaining that
-- selecting them threw "Unknown field `pickupState`" and crashed every trip
-- completion, so they were dropped from the select and left in the reads.
--
-- The result is that both are permanently `undefined`: place of supply always
-- falls back to the operating city's state, and the split is always INTRA.
-- For a Hyderabad pickup priced by the Bengaluru city row — which is what
-- happens today, because Hyderabad has no city row — that invoices a
-- Telangana trip under the Karnataka registration.
--
-- Recorded at booking time, from the resolved pickup/drop, so the invoice
-- states where the passenger actually embarked rather than where the rate
-- card came from.

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "pickup_state" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "drop_state"   VARCHAR(80);

-- Backfill from the operating city. Not strictly right — it is the fallback
-- the invoice already used — but it keeps historical rows reading the same
-- way they did before, rather than flipping to NULL and changing what an old
-- invoice would regenerate as.
UPDATE "bookings" b
   SET "pickup_state" = c."state"
  FROM "cities" c
 WHERE b."city_id" = c."id"
   AND b."pickup_state" IS NULL;

/* --- 5. The customer's GSTIN, captured at booking time ------------------- */
-- There is no GSTIN field anywhere in the booking flow: createBookingSchema
-- does not accept one and `bookings` has no column. The only doors are
-- PATCH /customers/me and the seven-field corporate registration, which is
-- why "Add GST" on the website has nowhere to post to.
--
-- Stored on the BOOKING as well as on the customer for the same reason
-- guest_name and guest_phone are: a guest checkout has no durable account to
-- hang it on, and the invoice still needs the number the customer typed.

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "gstin"            VARCHAR(15),
  ADD COLUMN IF NOT EXISTS "gst_company_name" VARCHAR(180);