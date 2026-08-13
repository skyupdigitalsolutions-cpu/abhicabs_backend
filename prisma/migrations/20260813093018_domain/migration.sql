-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('RETAIL', 'CORPORATE');

-- CreateEnum
CREATE TYPE "TripType" AS ENUM ('ONE_WAY', 'ROUND_TRIP');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('ZERO', 'PARTIAL', 'FULL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('UPI', 'CARD', 'NETBANKING', 'WALLET', 'CASH');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('ATTEMPTED', 'PENDING', 'CONFIRMED', 'ALLOCATED', 'EN_ROUTE', 'ONGOING', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('COMPLETED', 'PENDING', 'ABANDONED', 'FAILED');

-- CreateEnum
CREATE TYPE "CancelledBy" AS ENUM ('CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'AUTHORISED', 'CAPTURED', 'PARTIALLY_PAID', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('TAX', 'NON_TAX');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'MAINTENANCE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('FARE_CHARGED', 'ADVANCE_RECEIVED', 'BALANCE_RECEIVED', 'DRIVER_CREDIT', 'COMMISSION', 'WELFARE_FEE', 'CANCELLATION_FEE', 'REFUND', 'PAYOUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_FLIGHT', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('PER_TRIP', 'WEEKLY', 'MONTHLY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'DRIVER';
ALTER TYPE "Role" ADD VALUE 'OPS';
ALTER TYPE "Role" ADD VALUE 'FINANCE';
ALTER TYPE "Role" ADD VALUE 'FLEET';
ALTER TYPE "Role" ADD VALUE 'SUPPORT';

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" SERIAL NOT NULL,
    "role" "Role" NOT NULL,
    "permission" VARCHAR(48) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cities" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "state" VARCHAR(80) NOT NULL,
    "country" CHAR(2) NOT NULL DEFAULT 'IN',
    "centre_lat" DECIMAL(10,7) NOT NULL,
    "centre_lng" DECIMAL(10,7) NOT NULL,
    "radius_km" INTEGER NOT NULL DEFAULT 50,
    "timezone" VARCHAR(48) NOT NULL DEFAULT 'Asia/Kolkata',
    "languages" JSONB NOT NULL DEFAULT '["en","hi"]',
    "welfare_fee_pct" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fare_configs" (
    "id" SERIAL NOT NULL,
    "city_id" INTEGER NOT NULL,
    "vehicle_class" VARCHAR(24) NOT NULL,
    "trip_type" "TripType" NOT NULL,
    "base_fare" DECIMAL(10,2) NOT NULL,
    "per_km" DECIMAL(10,2) NOT NULL,
    "per_minute" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "minimum_fare" DECIMAL(10,2) NOT NULL,
    "cancellation_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "return_empty_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "min_km_per_day" INTEGER NOT NULL DEFAULT 0,
    "driver_allowance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "waiting_per_hour" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "free_waiting_min" INTEGER NOT NULL DEFAULT 0,
    "night_charge_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "night_start_hour" INTEGER NOT NULL DEFAULT 22,
    "night_end_hour" INTEGER NOT NULL DEFAULT 6,
    "max_surge" DECIMAL(4,2) NOT NULL DEFAULT 2.00,
    "min_surge" DECIMAL(4,2) NOT NULL DEFAULT 0.50,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fare_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "user_id" UUID NOT NULL,
    "account_type" "AccountType" NOT NULL DEFAULT 'RETAIL',
    "corporate_account_id" UUID,
    "alternate_phone" VARCHAR(20),
    "gstin" VARCHAR(15),
    "loyalty_points" INTEGER NOT NULL DEFAULT 0,
    "total_bookings" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "corporate_accounts" (
    "id" UUID NOT NULL,
    "company_name" VARCHAR(180) NOT NULL,
    "gstin" VARCHAR(15) NOT NULL,
    "pan" VARCHAR(10),
    "billing_email" VARCHAR(180) NOT NULL,
    "billing_phone" VARCHAR(20),
    "billing_address" TEXT NOT NULL,
    "billing_city" VARCHAR(80) NOT NULL,
    "billing_state" VARCHAR(80) NOT NULL,
    "billing_pincode" VARCHAR(10) NOT NULL,
    "billing_cycle" "BillingCycle" NOT NULL DEFAULT 'PER_TRIP',
    "credit_limit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "credit_used" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corporate_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "label" VARCHAR(40) NOT NULL,
    "line1" VARCHAR(255) NOT NULL,
    "line2" VARCHAR(255),
    "landmark" VARCHAR(120),
    "city" VARCHAR(80) NOT NULL,
    "state" VARCHAR(80) NOT NULL,
    "pincode" VARCHAR(10) NOT NULL,
    "lat" DECIMAL(10,7),
    "lng" DECIMAL(10,7),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "registration_number" VARCHAR(16) NOT NULL,
    "vehicle_class" VARCHAR(24) NOT NULL,
    "make_model" VARCHAR(80),
    "year" INTEGER,
    "colour" VARCHAR(40),
    "seating_capacity" INTEGER NOT NULL DEFAULT 4,
    "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "city_id" INTEGER,
    "insurance_expiry" DATE,
    "fitness_expiry" DATE,
    "permit_expiry" DATE,
    "puc_expiry" DATE,
    "documents" JSONB NOT NULL DEFAULT '{}',
    "odometer_km" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "user_id" UUID NOT NULL,
    "licence_number" VARCHAR(32) NOT NULL,
    "licence_expiry" DATE,
    "aadhaar_last4" CHAR(4),
    "kyc_status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "kyc_verified_at" TIMESTAMP(3),
    "police_verified_at" TIMESTAMP(3),
    "medical_checked_at" TIMESTAMP(3),
    "inducted_at" TIMESTAMP(3),
    "documents" JSONB NOT NULL DEFAULT '{}',
    "assigned_vehicle_id" UUID,
    "rating_avg" DECIMAL(3,2) NOT NULL DEFAULT 5.00,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "last_ping_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "booking_number" VARCHAR(20) NOT NULL,
    "customer_id" UUID NOT NULL,
    "corporate_account_id" UUID,
    "city_id" INTEGER NOT NULL,
    "trip_type" "TripType" NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "vehicle_class" VARCHAR(24) NOT NULL,
    "pickup_address" TEXT NOT NULL,
    "pickup_lat" DECIMAL(10,7) NOT NULL,
    "pickup_lng" DECIMAL(10,7) NOT NULL,
    "drop_address" TEXT NOT NULL,
    "drop_lat" DECIMAL(10,7) NOT NULL,
    "drop_lng" DECIMAL(10,7) NOT NULL,
    "stops" JSONB NOT NULL DEFAULT '[]',
    "pickup_at" TIMESTAMP(3) NOT NULL,
    "return_at" TIMESTAMP(3),
    "distance_km" DECIMAL(10,2),
    "duration_minutes" INTEGER,
    "estimated_fare" DECIMAL(12,2) NOT NULL,
    "final_fare" DECIMAL(12,2),
    "advance_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "balance_due" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cancellation_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refund_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "payment_mode" "PaymentMode" NOT NULL,
    "payment_method" "PaymentMethod",
    "fare_basis" JSONB NOT NULL,
    "surge_multiplier" DECIMAL(4,2) NOT NULL DEFAULT 1.00,
    "driver_share_pct" DECIMAL(5,2) NOT NULL DEFAULT 80.00,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_id" UUID,
    "cancelled_by_type" "CancelledBy",
    "cancellation_reason" TEXT,
    "special_requests" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "confirmed_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_attempts" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "booking_id" UUID,
    "outcome" "AttemptOutcome" NOT NULL DEFAULT 'PENDING',
    "trip_type" "TripType",
    "vehicle_class" VARCHAR(24),
    "pickup_address" TEXT,
    "drop_address" TEXT,
    "pickup_at" TIMESTAMP(3),
    "estimated_fare" DECIMAL(12,2),
    "failure_reason" VARCHAR(255),
    "source" VARCHAR(24),
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocations" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "driver_id" UUID,
    "status" "AllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "assigned_by_id" UUID,
    "accepted_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_events" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "lat" DECIMAL(10,7),
    "lng" DECIMAL(10,7),
    "odometer_km" INTEGER,
    "note" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "provider" VARCHAR(24) NOT NULL,
    "provider_order_id" VARCHAR(120),
    "provider_payment_id" VARCHAR(120),
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "method" "PaymentMethod",
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "purpose" VARCHAR(20) NOT NULL,
    "raw_response" JSONB NOT NULL DEFAULT '{}',
    "failure_reason" VARCHAR(255),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(24) NOT NULL,
    "event_id" VARCHAR(160) NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "signature" VARCHAR(255),
    "processed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "booking_id" UUID,
    "entry_type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "reference" VARCHAR(160) NOT NULL,
    "note" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "invoice_number" VARCHAR(40) NOT NULL,
    "series" VARCHAR(8) NOT NULL DEFAULT 'A',
    "financial_year" VARCHAR(9) NOT NULL,
    "type" "InvoiceType" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "customer_id" UUID,
    "corporate_account_id" UUID,
    "bill_to_name" VARCHAR(180) NOT NULL,
    "bill_to_address" TEXT,
    "bill_to_gstin" VARCHAR(15),
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxable_value" DECIMAL(12,2) NOT NULL,
    "cgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "place_of_supply" VARCHAR(80),
    "hsn_sac" VARCHAR(10),
    "notes" TEXT,
    "pdf_url" TEXT,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "booking_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" VARCHAR(120) NOT NULL,
    "user_id" UUID,
    "endpoint" VARCHAR(120) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_FLIGHT',
    "response_code" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(48) NOT NULL,
    "entity_id" VARCHAR(64),
    "before" JSONB,
    "after" JSONB,
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_permissions_role_idx" ON "role_permissions"("role");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_permission_key" ON "role_permissions"("role", "permission");

-- CreateIndex
CREATE INDEX "cities_is_active_idx" ON "cities"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "cities_name_state_key" ON "cities"("name", "state");

-- CreateIndex
CREATE INDEX "fare_configs_city_id_is_active_idx" ON "fare_configs"("city_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "fare_configs_city_id_vehicle_class_trip_type_effective_from_key" ON "fare_configs"("city_id", "vehicle_class", "trip_type", "effective_from");

-- CreateIndex
CREATE INDEX "customers_account_type_idx" ON "customers"("account_type");

-- CreateIndex
CREATE INDEX "customers_corporate_account_id_idx" ON "customers"("corporate_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_accounts_gstin_key" ON "corporate_accounts"("gstin");

-- CreateIndex
CREATE INDEX "corporate_accounts_is_active_idx" ON "corporate_accounts"("is_active");

-- CreateIndex
CREATE INDEX "addresses_customer_id_idx" ON "addresses"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_registration_number_key" ON "vehicles"("registration_number");

-- CreateIndex
CREATE INDEX "vehicles_status_idx" ON "vehicles"("status");

-- CreateIndex
CREATE INDEX "vehicles_vehicle_class_status_idx" ON "vehicles"("vehicle_class", "status");

-- CreateIndex
CREATE INDEX "vehicles_city_id_idx" ON "vehicles"("city_id");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_licence_number_key" ON "drivers"("licence_number");

-- CreateIndex
CREATE INDEX "drivers_kyc_status_idx" ON "drivers"("kyc_status");

-- CreateIndex
CREATE INDEX "drivers_is_online_idx" ON "drivers"("is_online");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_booking_number_key" ON "bookings"("booking_number");

-- CreateIndex
CREATE INDEX "bookings_customer_id_created_at_idx" ON "bookings"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "bookings"("status");

-- CreateIndex
CREATE INDEX "bookings_pickup_at_idx" ON "bookings"("pickup_at");

-- CreateIndex
CREATE INDEX "bookings_city_id_status_idx" ON "bookings"("city_id", "status");

-- CreateIndex
CREATE INDEX "bookings_corporate_account_id_idx" ON "bookings"("corporate_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_attempts_booking_id_key" ON "booking_attempts"("booking_id");

-- CreateIndex
CREATE INDEX "booking_attempts_outcome_created_at_idx" ON "booking_attempts"("outcome", "created_at");

-- CreateIndex
CREATE INDEX "booking_attempts_customer_id_idx" ON "booking_attempts"("customer_id");

-- CreateIndex
CREATE INDEX "booking_attempts_created_at_idx" ON "booking_attempts"("created_at");

-- CreateIndex
CREATE INDEX "allocations_booking_id_idx" ON "allocations"("booking_id");

-- CreateIndex
CREATE INDEX "allocations_vehicle_id_status_idx" ON "allocations"("vehicle_id", "status");

-- CreateIndex
CREATE INDEX "allocations_driver_id_status_idx" ON "allocations"("driver_id", "status");

-- CreateIndex
CREATE INDEX "allocations_starts_at_ends_at_idx" ON "allocations"("starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "trip_events_booking_id_occurred_at_idx" ON "trip_events"("booking_id", "occurred_at");

-- CreateIndex
CREATE INDEX "payments_booking_id_idx" ON "payments"("booking_id");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_provider_order_id_key" ON "payments"("provider", "provider_order_id");

-- CreateIndex
CREATE INDEX "webhook_events_processed_at_idx" ON "webhook_events"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_reference_key" ON "ledger_entries"("reference");

-- CreateIndex
CREATE INDEX "ledger_entries_user_id_created_at_idx" ON "ledger_entries"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_booking_id_idx" ON "ledger_entries"("booking_id");

-- CreateIndex
CREATE INDEX "ledger_entries_entry_type_created_at_idx" ON "ledger_entries"("entry_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices"("invoice_number");

-- CreateIndex
CREATE INDEX "invoices_customer_id_idx" ON "invoices"("customer_id");

-- CreateIndex
CREATE INDEX "invoices_corporate_account_id_idx" ON "invoices"("corporate_account_id");

-- CreateIndex
CREATE INDEX "invoices_issued_at_idx" ON "invoices"("issued_at");

-- CreateIndex
CREATE INDEX "invoices_type_status_idx" ON "invoices"("type", "status");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_lines_booking_id_idx" ON "invoice_lines"("booking_id");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "users_phone_idx" ON "users"("phone");

-- AddForeignKey
ALTER TABLE "fare_configs" ADD CONSTRAINT "fare_configs_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_corporate_account_id_fkey" FOREIGN KEY ("corporate_account_id") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_assigned_vehicle_id_fkey" FOREIGN KEY ("assigned_vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_corporate_account_id_fkey" FOREIGN KEY ("corporate_account_id") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_attempts" ADD CONSTRAINT "booking_attempts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_attempts" ADD CONSTRAINT "booking_attempts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_events" ADD CONSTRAINT "trip_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_corporate_account_id_fkey" FOREIGN KEY ("corporate_account_id") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
