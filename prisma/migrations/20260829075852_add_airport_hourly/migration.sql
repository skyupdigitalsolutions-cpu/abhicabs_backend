-- RenameForeignKey
ALTER TABLE "rental_packages" RENAME CONSTRAINT "rental_packages_city_fkey" TO "rental_packages_city_id_fkey";

-- RenameIndex
ALTER INDEX "rental_packages_city_class_active_idx" RENAME TO "rental_packages_city_id_vehicle_class_is_active_idx";
