-- Airport + hourly fields on fare_configs
ALTER TABLE "fare_configs"
  ADD COLUMN IF NOT EXISTS "airport_surcharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "hourly_rate"       DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "hourly_km_per_hour" INTEGER      NOT NULL DEFAULT 10;

-- Airport + rental fields on bookings
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "flight_number"     VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "rental_package_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "rental_hours"      INTEGER,
  ADD COLUMN IF NOT EXISTS "rental_km"         INTEGER;

-- Fixed rental packages (4hr/40km, 8hr/80km, 12hr/120km, etc.)
CREATE TABLE IF NOT EXISTS "rental_packages" (
  "id"             SERIAL PRIMARY KEY,
  "city_id"        INTEGER NOT NULL,
  "vehicle_class"  VARCHAR(24) NOT NULL,
  "label"          VARCHAR(40) NOT NULL,
  "included_hours" INTEGER NOT NULL,
  "included_km"    INTEGER NOT NULL,
  "package_fare"   DECIMAL(10,2) NOT NULL,
  "extra_per_hour" DECIMAL(10,2) NOT NULL,
  "extra_per_km"   DECIMAL(10,2) NOT NULL,
  "sort_order"     INTEGER NOT NULL DEFAULT 0,
  "is_active"      BOOLEAN NOT NULL DEFAULT true,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rental_packages_city_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "rental_packages_city_class_active_idx"
  ON "rental_packages" ("city_id", "vehicle_class", "is_active");