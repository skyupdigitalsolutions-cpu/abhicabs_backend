-- Promo codes.
--
-- WHERE THE DISCOUNT LANDS IN THE FARE: after the minimum-fare floor and
-- before rounding. The floor says what a trip must cost to be worth running;
-- a promo says what the business chooses to give away. Discounting first and
-- flooring after would cancel the promo on short trips, and the rider would
-- enter a code, see no change and conclude it was broken.
--
-- WHAT IT DOES NOT TOUCH: driver_share_pct is computed on the fare BEFORE the
-- discount. The driver drove the same distance either way; funding marketing
-- out of their share is a pay cut they did not agree to.

CREATE TYPE "DiscountType"  AS ENUM ('PERCENT', 'FLAT');
CREATE TYPE "DiscountScope" AS ENUM ('ALL_BOOKINGS', 'FIRST_RIDE', 'CORPORATE', 'AIRPORT');

CREATE TABLE "discounts" (
    "id"                     SERIAL          NOT NULL,
    "code"                   VARCHAR(32)     NOT NULL,
    "description"            VARCHAR(200)    NOT NULL,
    "type"                   "DiscountType"  NOT NULL,
    "value"                  DECIMAL(10,2)   NOT NULL,
    "max_discount"           DECIMAL(10,2),
    "min_fare"               DECIMAL(10,2)   NOT NULL DEFAULT 0,
    "max_uses"               INTEGER,
    "used_count"             INTEGER         NOT NULL DEFAULT 0,
    "max_uses_per_customer"  INTEGER         NOT NULL DEFAULT 1,
    "applies_to"             "DiscountScope" NOT NULL DEFAULT 'ALL_BOOKINGS',
    "starts_at"              TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"             TIMESTAMP(3),
    "is_active"              BOOLEAN         NOT NULL DEFAULT true,
    "created_by_id"          UUID,
    "created_at"             TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "discounts_code_key" ON "discounts"("code");
CREATE INDEX "discounts_is_active_expires_at_idx" ON "discounts"("is_active", "expires_at");

-- One row per use, not just a counter on discounts.
--
-- A counter cannot answer "has THIS customer used it", cannot be audited when
-- a rider disputes a charge, and cannot be reversed when a booking is
-- cancelled. booking_id is UNIQUE: one promo per booking, enforced by the
-- database rather than by remembering to check.
CREATE TABLE "discount_redemptions" (
    "id"          SERIAL        NOT NULL,
    "discount_id" INTEGER       NOT NULL,
    "booking_id"  UUID          NOT NULL,
    "customer_id" UUID          NOT NULL,
    "amount"      DECIMAL(10,2) NOT NULL,
    "created_at"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "discount_redemptions_booking_id_key"
    ON "discount_redemptions"("booking_id");
CREATE INDEX "discount_redemptions_discount_id_customer_id_idx"
    ON "discount_redemptions"("discount_id", "customer_id");

ALTER TABLE "discount_redemptions"
    ADD CONSTRAINT "discount_redemptions_discount_id_fkey"
    FOREIGN KEY ("discount_id") REFERENCES "discounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;