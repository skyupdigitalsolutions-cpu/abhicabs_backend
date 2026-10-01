-- ---------------------------------------------------------------------------
-- Three commercial changes, in one migration because they all touch pricing
-- and shipping them apart would leave the rate card briefly incoherent.
--
--   1. MINIMUM FARE  ->  MINIMUM KM
--   2. ONE-WAY NO LONGER CHARGES THE RETURN LEG
--   3. SURGE IS LIVE AGAIN, FOR METRO PICKUPS ONLY
--
-- The fare-config cache key is bumped to v5 in the same deploy
-- (quote.service FARE_CFG_CACHE_VERSION). A migration writes behind that
-- cache, so without the bump booking creation would keep pricing from a
-- six-hour-old cached row while the fare list showed the new one, and a rider
-- would be quoted one total and booked at another.
-- ---------------------------------------------------------------------------


/* ====================================================================== *
 * 1. MINIMUM FARE  ->  MINIMUM KM
 * ====================================================================== *
 *
 * The floor on a short trip was a sum of money: a fare below `minimum_fare`
 * was topped up to it, with a "Minimum fare adjustment" line that had no
 * visible relationship to anything above it on the breakdown.
 *
 * It is now a DISTANCE. A trip shorter than `minimum_km` is billed as though
 * it covered that many kilometres, at whatever the current per-km rate is.
 *
 * WHY THIS IS BETTER AND NOT JUST DIFFERENT
 *   - A rupee floor has to be re-derived by hand every time a rate moves. Put
 *     per_km up by 15% and yesterday's 900 minimum silently stops representing
 *     the distance it was written for. "Minimum 50 km" re-prices itself.
 *   - It is how the trade already quotes: operators say "minimum 50 km", not
 *     "minimum 900 rupees".
 *   - It reads honestly to the rider: the breakdown shows the kilometres they
 *     were billed for and says the trip was shorter, instead of an
 *     unexplained adjustment line.
 *
 * THE COLUMN IS ADDED AT 0 — NO FLOOR — RATHER THAN CONVERTED.
 *
 * Converting (minimum_fare / per_km) was considered and rejected. The arithmetic
 * is only valid on a card whose fare is pure distance, and it is not: every
 * ONE_WAY card currently doubles its distance through return_empty_pct (which
 * step 2 below removes), and HOURLY rows use minimum_fare for something else
 * entirely — 20260922140000_fleet_models stored the EXTRA-HOUR rate there.
 * A blanket conversion would have produced a plausible-looking number per row
 * and a wrong one on most of them, which is worse than an honest zero.
 *
 * So: no floor applies until an admin sets one per card, from the Rate Cards
 * screen. Nothing gets quietly more expensive on deploy.
 */

ALTER TABLE "fare_configs"
  ADD COLUMN IF NOT EXISTS "minimum_km" DECIMAL(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN "fare_configs"."minimum_km" IS
  'Minimum billable distance. billableKm = max(actualKm, minimum_km, min_km_per_day * days). 0 = no floor.';

/* Retire the rupee floor.
 *
 * Zeroed, not dropped: minimum_fare is part of the configSnapshot frozen onto
 * every booking.fareBasis ever written, and dropping it would break the read
 * path for bookings already taken. The fare engine no longer reads the column
 * at all — it freezes a literal '0.00' — so this is housekeeping that makes
 * the table read honestly rather than a behavioural change.
 *
 * NOTE: this erases the HOURLY extra-hour rate that 20260922140000 parked in
 * this column. That is safe because the same migration wrote the identical
 * value into hourly_rate, which is what fare.service.computeExtraTimeCharge
 * has always actually read. The guard below is belt and braces: it refuses to
 * zero an HOURLY row whose hourly_rate was never populated, so no card can
 * lose its only copy of that rate.
 */

UPDATE "fare_configs"
SET "hourly_rate" = "minimum_fare"
WHERE "trip_type" = 'HOURLY'
  AND COALESCE("hourly_rate", 0) = 0
  AND COALESCE("minimum_fare", 0) > 0;

UPDATE "fare_configs"
SET "minimum_fare" = 0
WHERE "minimum_fare" <> 0;

COMMENT ON COLUMN "fare_configs"."minimum_fare" IS
  'RETIRED, always 0. Replaced by minimum_km. Kept because it is part of the frozen fareBasis snapshot on past bookings.';


/* ====================================================================== *
 * 2. ONE-WAY NO LONGER CHARGES THE RETURN LEG
 * ====================================================================== *
 *
 * 20260923160000 and 20260928090000 set return_empty_pct = 100 on every
 * ONE_WAY card, so the engine charged the distance a second time to pay for
 * the driver coming back empty.
 *
 * The effect was that a card advertising 19.00/km billed 38.00/km. The client's
 * own published rate sheet says 19.00 flat, and 20260923160000's own comment
 * flagged the contradiction at the time:
 *
 *     "Worth being explicit, because the client's own rate sheet quotes 19/km
 *      with no mention of a return charge. If that 19 was ever meant to be the
 *      all-in price, this bills every one-way at twice the published rate."
 *
 * It was. This resolves it in the direction the rate sheet always stated.
 *
 * WHERE THE RETURN COST GOES INSTEAD: into the ONE_WAY per_km rate itself.
 * fare_configs is keyed by trip type, so ONE_WAY and ROUND_TRIP have had
 * independent per_km columns all along and have simply been carrying the same
 * number. From here they diverge on purpose — a one-way rate is set higher
 * because it already assumes an empty return, and a round-trip rate lower
 * because both legs carry the passenger. See round-trip-per-km.sql.
 *
 * PRICE IMPACT: every one-way fare roughly HALVES, back to the published rate.
 * Bengaluru-Hubli in a Swift Dzire goes from about 16,500 to about 8,250.
 * Bookings already taken are untouched — each froze its own fareBasis.
 */

UPDATE "fare_configs"
SET "return_empty_pct" = 0
WHERE "return_empty_pct" <> 0;

COMMENT ON COLUMN "fare_configs"."return_empty_pct" IS
  'RETIRED, always 0. The empty return is priced into the ONE_WAY per_km rate. Round trips bill both legs via doubled distance. Kept for the frozen fareBasis snapshot on past bookings.';


/* ====================================================================== *
 * 3. SURGE IS LIVE AGAIN, FOR METRO PICKUPS ONLY
 * ====================================================================== *
 *
 * 20260929092000_disable_demand_pricing pinned every card's surge band to
 * 1.00/1.00 so no fare could carry a premium. Demand pricing is wanted again,
 * but narrowly: inside metro areas, at a percentage only an admin sets.
 *
 * THREE INDEPENDENT GATES, and a client controls none of them:
 *
 *   surge.service    charges a premium only when the PICKUP classifies as
 *                    METRO (SURGEABLE_TIERS, enforced in code so a copied rule
 *                    row cannot widen it), and reads the percentage from
 *                    surge_rules.
 *   surge_rules      written only through PATCH /admin/surge/rules/:tier,
 *                    behind the FARE_EDIT permission and audited as
 *                    SURGE_RULE_UPDATED with before/after values.
 *   fare_configs     min_surge/max_surge clamp whatever arrives, per card.
 *                    MVAG caps dynamic pricing at 2x the notified fare, which
 *                    is where 2.00 comes from.
 */

/* 3a. Reopen the band so a premium can reach a fare at all.
 *
 * Only reopened where it was pinned shut by the disable migration. A card an
 * admin has deliberately set to something else since keeps that value.
 */

UPDATE "fare_configs"
SET "max_surge" = 2.00
WHERE "max_surge" = 1.00;

UPDATE "fare_configs"
SET "min_surge" = 1.00
WHERE "min_surge" <> 1.00;

ALTER TABLE "fare_configs" ALTER COLUMN "max_surge" SET DEFAULT 2.00;

/* 3b. The tier rules.
 *
 * METRO ships at 0% ON PURPOSE. Enabling surge must be a deliberate act by an
 * admin on the Surge screen, not something that switches itself on the moment
 * this deploys and starts charging riders a premium nobody signed off. The
 * row is active and ready; the number is the business's to set.
 *
 * immediate_within_minutes = 60 is the window inside which a booking counts as
 * urgent, kept from the previous configuration.
 */

INSERT INTO "surge_rules" ("tier","immediate_within_minutes","immediate_pct","standard_pct","is_active","updated_at")
VALUES ('METRO', 60, 0, 0, true, CURRENT_TIMESTAMP)
ON CONFLICT ("tier") DO UPDATE
SET "is_active" = true,
    "immediate_within_minutes" = 60,
    "updated_at" = CURRENT_TIMESTAMP;

/* TALUKA and VILLAGE are zeroed and deactivated.
 *
 * The resolver already refuses to charge outside METRO, so this is belt and
 * braces — but it matters that the table agrees with the code. An admin
 * reading surge_rules and finding a live 15% on VILLAGE would reasonably
 * conclude village pickups are surcharged, and would be wrong.
 *
 * It also corrects an asymmetry that was hard to defend: the old rules charged
 * MORE in a village (10% standing, 15% urgent) than in a city, on the argument
 * that supply is thinner there. True, and it meant the customers with the
 * fewest alternatives paid the largest premium.
 */

UPDATE "surge_rules"
SET "immediate_pct" = 0,
    "standard_pct" = 0,
    "is_active" = false,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "tier" <> 'METRO';