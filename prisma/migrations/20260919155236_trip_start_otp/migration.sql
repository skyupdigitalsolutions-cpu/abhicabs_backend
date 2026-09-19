-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "start_otp" VARCHAR(8),
ADD COLUMN     "start_otp_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "start_otp_issued_at" TIMESTAMP(3),
ADD COLUMN     "start_otp_verified_at" TIMESTAMP(3);
