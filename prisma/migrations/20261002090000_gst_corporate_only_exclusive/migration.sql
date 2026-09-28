-- ---------------------------------------------------------------------------
-- GST: corporate accounts only, and added ON TOP of the fare
-- ---------------------------------------------------------------------------
--
-- Two changes, both of which alter what a customer is shown and charged.
--
-- 1. WHO IS TAXED — corporate only.
--    A personal rider now sees no GST anywhere: not on the vehicle card, not
--    in the checkout sheet, and their invoice is a bill of supply with no tax
--    lines. This matches what billing.service has always done for retail, and
--    removes a real inconsistency: a personal rider was being shown
--    "Includes GST @18%" on a fare that was then invoiced with no tax at all.
--
--    apply_retail defaults to FALSE and apply_corporate to TRUE, so a state
--    added later is corporate-only unless someone deliberately says otherwise.
--
-- 2. HOW IT IS CHARGED — exclusive, not inclusive.
--    The tax is ADDED to the fare rather than backed out of it. A corporate
--    Rs 15,546 fare now bills Rs 18,344.28 (Rs 15,546 + Rs 2,798.28), where
--    before it billed Rs 15,546 containing Rs 2,371.42 of embedded tax.
--
--    This is a PRICE INCREASE for corporate customers of exactly the rate.
--    Retail fares are unchanged, because retail is no longer taxed.
--
-- The UPDATE at the end applies both to the rows that already exist, not just
-- to rows created after this. Without it the defaults would only govern new
-- states and the two seeded registrations would keep their old behaviour —
-- which is the whole bug this migration exists to fix.
-- ---------------------------------------------------------------------------

ALTER TABLE "gst_config"
  ADD COLUMN IF NOT EXISTS "apply_retail"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "apply_corporate" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "gst_config" ALTER COLUMN "is_inclusive" SET DEFAULT false;

UPDATE "gst_config"
   SET "is_inclusive"    = false,
       "apply_retail"    = false,
       "apply_corporate" = true; 