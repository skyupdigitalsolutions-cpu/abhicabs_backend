-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'REACHED';

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "reached_at" TIMESTAMP(3);
