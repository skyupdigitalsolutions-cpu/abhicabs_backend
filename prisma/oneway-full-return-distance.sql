-- ===========================================================================
-- One-way trips: bill the FULL return distance.
--
-- No code change. The engine already computes the return leg as a percentage
-- of the distance charge (src/services/fare.service.js):
--
--   if (!isRoundTrip && M.dec(config.returnEmptyPct ?? 0).greaterThan(0))
--       returnEmpty = distanceCharge x returnEmptyPct / 100
--
-- so 100 means "the return leg costs the same as the outbound leg", which is
-- exactly 2x the distance charge. The breakdown line reads
--
--   Return journey (100.00% of distance)      13,590.96
--
-- ---------------------------------------------------------------------------
-- THIS REVERSES THE EARLIER CHANGE
-- ---------------------------------------------------------------------------
-- disable-time-and-return-charges.sql set this column to 0. This sets it to
-- 100 — higher than the 40 it held before either change. On the 566 km SUV
-- quote the effect is:
--
--   40  (original)        22,533   ->  ₹39.79/km
--   0   (previous change) 14,291   ->  ₹25.24/km
--   100 (this change)     27,882   ->  ₹49.24/km
--
-- For comparison, savaari.com advertises an Innova from about ₹12.50/km on
-- one-way outstation, all-inclusive of tolls and driver allowance. Their
-- per-km rate already contains the empty return; that is why one-way rates run
-- higher than round-trip ones.
--
-- If per_km was set as a ONE-WAY rate, it already prices the deadhead leg and
-- this line charges for it a second time. Check what per_km was derived from
-- before running this.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Preview: what each row charges now, and what it will charge.
-- ---------------------------------------------------------------------------
SELECT
  c.name             AS city,
  f.vehicle_class,
  f.per_km,
  f.return_empty_pct AS pct_now,
  100                AS pct_after,
  ROUND(f.per_km * 500 * f.return_empty_pct / 100, 2) AS return_now_on_500km,
  ROUND(f.per_km * 500, 2)                            AS return_after_on_500km
FROM fare_configs f
JOIN cities c ON c.id = f.city_id
WHERE f.is_active = true
  AND f.trip_type = 'ONE_WAY'
ORDER BY c.name, f.vehicle_class;

-- ---------------------------------------------------------------------------
-- 2. Apply. ONE_WAY only — it is the only trip type the engine applies the
--    return leg to. A round trip drives the passenger back, so there is no
--    empty leg to recover.
-- ---------------------------------------------------------------------------
UPDATE fare_configs
SET return_empty_pct = 100
WHERE trip_type = 'ONE_WAY';

-- ---------------------------------------------------------------------------
-- 3. Verify. Expect ZERO rows.
-- ---------------------------------------------------------------------------
SELECT id, city_id, vehicle_class, return_empty_pct
FROM fare_configs
WHERE is_active = true
  AND trip_type = 'ONE_WAY'
  AND return_empty_pct <> 100;

COMMIT;
-- ROLLBACK;  -- if the preview looked wrong

-- ===========================================================================
-- Existing bookings are untouched.
-- Each froze its own fareBasis at creation, so past fares stay reproducible
-- and old invoices still reconcile. Only NEW quotes change.
-- ===========================================================================