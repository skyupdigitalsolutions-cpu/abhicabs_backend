-- ---------------------------------------------------------------------------
-- GST: one row per state the client is registered in
-- ---------------------------------------------------------------------------
--
-- Replaces the hardcoded GST_RATE_PCT env var. Everything about tax is a row
-- an admin can edit: the GSTIN, the rate, which trip types are taxed, and
-- whether the fare already contains the tax.
--
-- ONE TABLE, ON PURPOSE
-- Who bills a trip and what rate applies could be split apart, and at a larger
-- scale they should be — they change for different reasons. At two
-- registrations and four trip types, one row per state is simpler to edit, to
-- query and to reason about, and the cost is small and known:
--
--   * A fifth trip type means a schema change, not a row. TripType is an enum,
--     so adding one already requires a migration.
--   * interstate_by_route repeats on every row, so two states could in
--     principle disagree about a rule that is a reading of the law rather than
--     a local variation. Keep them the same.
--
-- HOW ADMIN REMOVES GST FROM A TRIP TYPE
--   UPDATE "gst_config" SET "apply_round_trip" = false WHERE "state" = 'Karnataka';
-- The rate stays on the row, so switching it back on needs no re-entry.
--
-- WHICH ROW BILLS A TRIP
-- The one matching the PICKUP state, per the requirement: a Bengaluru pickup
-- bills on Karnataka whatever the destination. No row for that state means no
-- tax invoice — not a tax invoice with a missing GSTIN, which is not valid.
--
-- TWO FLAGS DEFAULTED TO TODAY'S BEHAVIOUR
-- Both change what a customer pays, so neither is assumed:
--
--   is_inclusive = true
--     Fares are quoted GST-inclusive today, so a Rs 23,963 fare stays
--     Rs 23,963 and carries Rs 3,655.37 of embedded GST. Set false and the
--     same trip bills Rs 28,276.34 — an 18% rise for every customer. That is a
--     pricing decision, not a tax one.
--
--   interstate_by_route = false
--     How CGST+SGST vs IGST is chosen.
--       false — by PLACE OF SUPPLY, which for passenger transport is where the
--               passenger embarks: the pickup. Billing on the pickup state's
--               GSTIN then makes every trip intra-state, Bengaluru to
--               Hyderabad included.
--       true  — by ROUTE: pickup state vs drop state, so that trip raises
--               IGST. This is what was asked for, but it issues an IGST
--               invoice under a Karnataka GSTIN for a Karnataka place of
--               supply, which is the combination an audit flags.
--     CONFIRM WITH A CA BEFORE CHANGING THIS.
-- ---------------------------------------------------------------------------

ALTER TABLE "cities" ADD COLUMN IF NOT EXISTS "district" VARCHAR(80);

CREATE TABLE IF NOT EXISTS "gst_config" (
  "id"       SERIAL PRIMARY KEY,

  -- Matched against a booking's pickup city state, so store it exactly as
  -- cities.state is written.
  "state"    VARCHAR(80)  NOT NULL,
  "district" VARCHAR(80),
  "gstin"    VARCHAR(15)  NOT NULL,

  -- As they must appear on a tax invoice. Snapshotted onto each invoice at
  -- issue, so correcting a typo here never rewrites an invoice a customer
  -- already holds.
  "legal_name" VARCHAR(180) NOT NULL,
  "address"    TEXT,

  "rate_pct"     DECIMAL(5,2) NOT NULL DEFAULT 18.00,
  "is_inclusive" BOOLEAN      NOT NULL DEFAULT true,

  -- Per trip type, so GST can be removed from one without touching the others.
  "apply_one_way"    BOOLEAN NOT NULL DEFAULT true,
  "apply_round_trip" BOOLEAN NOT NULL DEFAULT true,
  "apply_airport"    BOOLEAN NOT NULL DEFAULT true,
  "apply_hourly"     BOOLEAN NOT NULL DEFAULT true,

  "interstate_by_route" BOOLEAN NOT NULL DEFAULT false,
  "hsn_sac"             VARCHAR(10) NOT NULL DEFAULT '9964',

  -- False retires a registration without deleting it, so invoices issued under
  -- it stay explainable.
  "is_active" BOOLEAN NOT NULL DEFAULT true,

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One ACTIVE row per state. Partial, not plain unique: a superseded
-- registration stays in the table and must not block its replacement.
CREATE UNIQUE INDEX IF NOT EXISTS "gst_config_state_active_key"
  ON "gst_config"("state") WHERE "is_active";

CREATE UNIQUE INDEX IF NOT EXISTS "gst_config_gstin_key" ON "gst_config"("gstin");

-- The two known registrations. GSTINs are PLACEHOLDERS in the correct format
-- (2-digit state code + PAN + entity + Z + check char) and MUST be replaced
-- with the real ones before any invoice is issued. 29 = Karnataka,
-- 27 = Maharashtra.
INSERT INTO "gst_config" ("state", "district", "gstin", "legal_name")
SELECT * FROM (VALUES
  ('Karnataka',   'Kalaburagi', '29AAAAA0000A1Z5', 'AbhiCabs'),
  ('Maharashtra', NULL,         '27AAAAA0000A1Z5', 'AbhiCabs')
) AS v(state, district, gstin, legal_name)
WHERE NOT EXISTS (
  SELECT 1 FROM "gst_config" g WHERE g."state" = v.state AND g."is_active"
);

-- Invoice: record WHO issued it and under what rule, so it stays explainable
-- after the registration or rate has moved on.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "seller_gstin"      VARCHAR(15);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "seller_state"      VARCHAR(80);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "seller_legal_name" VARCHAR(180);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "seller_address"    TEXT;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "gst_rate_pct"      DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "gst_inclusive"     BOOLEAN NOT NULL DEFAULT true;