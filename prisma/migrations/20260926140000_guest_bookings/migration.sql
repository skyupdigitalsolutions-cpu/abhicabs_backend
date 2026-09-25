-- Guest checkout for the website.
--
-- ISOLATION IS THE DESIGN. A guest never matches an existing account.
--
-- users.phone is UNIQUE and the WhatsApp bot resolves a customer by it, on the
-- strength of Meta having verified that number. A web form verifies nothing —
-- so if guest checkout looked a customer up by phone, typing someone else's
-- number would hand over their saved addresses, their booking history and
-- their corporate billing. A public form must not be an account-takeover
-- route.
--
-- So: a guest gets their own users row with phone left NULL, and the contact
-- details live on the booking. Nothing is looked up, so nothing can be claimed.
--
-- The cost, stated plainly: a guest who is already a customer gets a second
-- record, and the guest booking never appears in their app history. Lifting
-- that requires verifying the phone, which is a separate decision.

ALTER TABLE "customers" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "bookings" ADD COLUMN "guest_name"  VARCHAR(120);
ALTER TABLE "bookings" ADD COLUMN "guest_phone" VARCHAR(20);
ALTER TABLE "bookings" ADD COLUMN "guest_email" VARCHAR(180);

CREATE INDEX "customers_is_guest_idx" ON "customers"("is_guest");

-- Guests are looked up by booking number + phone, never by phone alone.
CREATE INDEX "bookings_guest_phone_idx" ON "bookings"("guest_phone");