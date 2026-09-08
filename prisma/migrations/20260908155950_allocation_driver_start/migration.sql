-- AlterTable
ALTER TABLE "allocations" ADD COLUMN     "driver_start_at" TIMESTAMP(3),
ADD COLUMN     "driver_start_lat" DECIMAL(10,7),
ADD COLUMN     "driver_start_lng" DECIMAL(10,7);
