-- CreateEnum
CREATE TYPE "BookingRequestStatus" AS ENUM ('NEW', 'REVIEWING', 'QUOTED', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "booking_requests" (
    "id" UUID NOT NULL,
    "request_number" VARCHAR(20) NOT NULL,
    "customer_id" UUID NOT NULL,
    "trip_type" "TripType" NOT NULL,
    "vehicle_class" VARCHAR(24),
    "pickup_address" TEXT NOT NULL,
    "pickup_lat" DECIMAL(10,7),
    "pickup_lng" DECIMAL(10,7),
    "pickup_state" VARCHAR(64),
    "drop_address" TEXT NOT NULL,
    "drop_lat" DECIMAL(10,7),
    "drop_lng" DECIMAL(10,7),
    "drop_state" VARCHAR(64),
    "pickup_at" TIMESTAMP(3) NOT NULL,
    "return_at" TIMESTAMP(3),
    "passengers" SMALLINT,
    "note" VARCHAR(500),
    "contact_name" VARCHAR(120),
    "contact_phone" VARCHAR(20),
    "contact_email" VARCHAR(180),
    "reason" VARCHAR(200),
    "status" "BookingRequestStatus" NOT NULL DEFAULT 'NEW',
    "admin_note" VARCHAR(1000),
    "handled_by_id" UUID,
    "handled_at" TIMESTAMP(3),
    "converted_booking_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "booking_requests_request_number_key" ON "booking_requests"("request_number");

-- CreateIndex
CREATE INDEX "booking_requests_status_created_at_idx" ON "booking_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "booking_requests_customer_id_created_at_idx" ON "booking_requests"("customer_id", "created_at");

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_handled_by_id_fkey" FOREIGN KEY ("handled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
