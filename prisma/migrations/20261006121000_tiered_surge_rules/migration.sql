-- ---------------------------------------------------------------------------
-- FOUR-TIER SURGE, ALL OF IT ADMIN-EDITABLE
-- ---------------------------------------------------------------------------
--
-- The second half of the change begun in 20261006120000, which added the
-- DISTRICT enum value. It is a separate file because PostgreSQL refuses to let
-- a new enum value be used in the transaction that created it, and Prisma runs
-- one transaction per migration — so this file is the commit boundary that
-- makes 'DISTRICT' usable. Do not merge the two back together.
--
-- 20261006090000 reopened the surge band but restricted premiums to METRO, on
-- the reading that "add surge in the metro city" meant metros were the only
-- place a premium applied. That was wrong: the business prices all four tiers,
-- and the rural percentages were a standing policy, not an oversight.
--
--   TIER      STANDING   SHORT NOTICE   WINDOW
--   METRO       0%           0%          1 hr    (admin to set — see below)
--   DISTRICT    5%          10%          4 hrs   (same as TALUKA)
--   TALUKA      5%          10%          4 hrs
--   VILLAGE    10%          15%          4 hrs
--
-- Every figure is editable from the admin dashboard afterwards
-- (PATCH /admin/surge/rules/:tier, FARE_EDIT, audited). These are starting
-- values, not constants.
--
-- ---------------------------------------------------------------------------
-- WHY THE WINDOW IS FOUR HOURS OUTSIDE A METRO
-- ---------------------------------------------------------------------------
-- It was 60 minutes, from when surge meant "booked right now" in a city. That
-- clock does not describe anywhere else: a village booking an hour out and one
-- four hours out are the same problem to dispatch, because the car is coming
-- from the same distance either way. Four hours is roughly where finding one
-- stops being a scramble.
--
-- METRO keeps 60 minutes. A dense fleet genuinely can fill a booking inside
-- the hour, so the shorter window is the honest one there — and applying four
-- hours would surcharge half a day's city bookings as "short notice".
--
-- The column is per tier precisely so these can differ.
-- ---------------------------------------------------------------------------


-- VILLAGE: thin supply, often a single car, no fallback if it declines.
INSERT INTO "surge_rules" ("tier","immediate_within_minutes","immediate_pct","standard_pct","is_active","updated_at")
VALUES ('VILLAGE', 240, 15, 10, true, CURRENT_TIMESTAMP)
ON CONFLICT ("tier") DO UPDATE
SET "immediate_within_minutes" = EXCLUDED."immediate_within_minutes",
    "immediate_pct"            = EXCLUDED."immediate_pct",
    "standard_pct"             = EXCLUDED."standard_pct",
    "is_active"                = true,
    "updated_at"               = CURRENT_TIMESTAMP;

-- TALUKA: a town served from further out, but not isolated.
INSERT INTO "surge_rules" ("tier","immediate_within_minutes","immediate_pct","standard_pct","is_active","updated_at")
VALUES ('TALUKA', 240, 10, 5, true, CURRENT_TIMESTAMP)
ON CONFLICT ("tier") DO UPDATE
SET "immediate_within_minutes" = EXCLUDED."immediate_within_minutes",
    "immediate_pct"            = EXCLUDED."immediate_pct",
    "standard_pct"             = EXCLUDED."standard_pct",
    "is_active"                = true,
    "updated_at"               = CURRENT_TIMESTAMP;

/*
 * DISTRICT: the same numbers as TALUKA, by decision.
 *
 * Written out in full rather than copied from the taluka row with a SELECT.
 * The two tiers happen to price the same TODAY, and that is a commercial
 * coincidence, not a rule — a district headquarters is a different kind of
 * place from a taluka town and the business may well diverge them later. A
 * query that derived one from the other would quietly re-couple them every
 * time this ran, and an admin who changed taluka on the dashboard would find
 * district had moved too.
 *
 * The separate row is also what makes them independently editable, which is
 * the whole point of a per-tier table.
 */

INSERT INTO "surge_rules" ("tier","immediate_within_minutes","immediate_pct","standard_pct","is_active","updated_at")
VALUES ('DISTRICT', 240, 10, 5, true, CURRENT_TIMESTAMP)
ON CONFLICT ("tier") DO UPDATE
SET "immediate_within_minutes" = EXCLUDED."immediate_within_minutes",
    "immediate_pct"            = EXCLUDED."immediate_pct",
    "standard_pct"             = EXCLUDED."standard_pct",
    "is_active"                = true,
    "updated_at"               = CURRENT_TIMESTAMP;

/*
 * METRO STILL SHIPS AT 0% — ON PURPOSE, AND THIS IS NOT AN OVERSIGHT.
 *
 * No metro percentages have been specified. The other three tiers have stated
 * figures and are seeded with them; this one does not, and inventing a number
 * would be inventing a price — the one thing a migration must never do
 * quietly. A rider would pay it before anyone had agreed it.
 *
 * The row is ACTIVE and ready, so enabling it is one edit on the Surge screen
 * with no deploy. Until then metro pickups carry no premium, which is the
 * correct behaviour for a price nobody has approved.
 *
 * Note this leaves metros as the CHEAPEST tier, which is the intended shape:
 * a premium should track how hard a car is to find, and in a city it is not.
 */

INSERT INTO "surge_rules" ("tier","immediate_within_minutes","immediate_pct","standard_pct","is_active","updated_at")
VALUES ('METRO', 60, 0, 0, true, CURRENT_TIMESTAMP)
ON CONFLICT ("tier") DO UPDATE
SET "is_active"  = true,
    "updated_at" = CURRENT_TIMESTAMP;


/* ====================================================================== *
 * THE DEFAULT WINDOW
 * ====================================================================== *
 *
 * So a tier added later starts at the four-hour window rather than the
 * metro-only one-hour assumption this policy replaced.
 */

ALTER TABLE "surge_rules" ALTER COLUMN "immediate_within_minutes" SET DEFAULT 240;


/* ====================================================================== *
 * THE RATE-CARD BAND STILL CAPS ALL OF IT
 * ====================================================================== *
 *
 * Worth restating because it is the control that keeps this legal: whatever a
 * rule says, fare.service clamps the multiplier to each card's
 * min_surge/max_surge. MVAG caps dynamic pricing at 2x the notified fare, and
 * 20261006090000 set max_surge to 2.00. A village rider booking at short
 * notice therefore pays 15% — not 15% compounded with anything else, and never
 * more than double the published fare.
 *
 * A single class or trip type is exempted by setting ITS card to max_surge
 * 1.00, with no change to any tier rule.
 */