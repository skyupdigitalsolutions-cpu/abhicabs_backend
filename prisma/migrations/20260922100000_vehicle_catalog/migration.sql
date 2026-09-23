-- Rider-facing catalogue of vehicle CLASSES (distinct from the `vehicles`
-- table, which holds individual cars). See the model comment in schema.prisma.

CREATE TABLE "vehicle_catalog" (
    "id"             SERIAL        NOT NULL,
    "key"            VARCHAR(24)   NOT NULL,
    "name"           VARCHAR(60)   NOT NULL,
    "seats"          INTEGER       NOT NULL,
    "blurb"          VARCHAR(160)  NOT NULL,
    "detail"         VARCHAR(1000) NOT NULL,
    "luggage"        VARCHAR(60)   NOT NULL,
    "glyph"          VARCHAR(8)    NOT NULL DEFAULT '🚗',
    "transmission"   VARCHAR(16),
    "fuel"           VARCHAR(16),
    "rating"         DECIMAL(3,2),
    "trips"          INTEGER,
    "hero_url"       TEXT,
    "hero_public_id" VARCHAR(200),
    "images"         JSONB         NOT NULL DEFAULT '[]',
    "sort_order"     INTEGER       NOT NULL DEFAULT 0,
    "is_active"      BOOLEAN       NOT NULL DEFAULT true,
    "created_at"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "vehicle_catalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_catalog_key_key" ON "vehicle_catalog"("key");
CREATE INDEX "vehicle_catalog_is_active_sort_order_idx"
    ON "vehicle_catalog"("is_active", "sort_order");

-- Seed the classes the app ships with, carrying over the copy that used to
-- live in the app's src/config/vehicles.ts.
--
-- `key` MUST match the vehicleClass strings in fare_configs and vehicles.
-- Lowercase, exactly as seeded there — a capitalised key here produces a class
-- a rider can browse and then cannot be quoted for.
--
-- Images are left NULL on purpose. They are uploaded through the admin panel
-- to Cloudinary; seeding a URL would bake a dead link into the migration.
INSERT INTO "vehicle_catalog"
  ("key","name","seats","blurb","detail","luggage","glyph","transmission","fuel","sort_order","updated_at")
VALUES
  ('hatchback','Hatchback',4,
   'Compact and budget-friendly',
   'The cheapest way to get across town. Best for one or two people with light bags.',
   '1 small bag','🚗','Manual','Petrol',10, CURRENT_TIMESTAMP),

  ('sedan','Sedan',4,
   'Comfortable for city rides',
   'More legroom and boot space than a hatchback. The usual choice for airport runs.',
   '2 medium bags','🚗','Manual','Petrol',20, CURRENT_TIMESTAMP),

  ('suv','SUV',6,
   'More room, longer trips',
   'Six seats and a high ride. Worth it for outstation trips and rougher roads.',
   '4 large bags','🚙','Manual','Diesel',30, CURRENT_TIMESTAMP),

  ('luxury','Luxury',4,
   'Premium cars, chauffeur driven',
   'Executive sedans for airport transfers, client pickups and weddings. Chauffeur in uniform, bottled water, and a car under three years old.',
   '2 large bags','🚘','Automatic','Diesel',40, CURRENT_TIMESTAMP),

  ('tempo','Tempo Traveller',12,
   'Group travel, large luggage',
   'Twelve seats for family trips, office outings and weddings. Book ahead.',
   '10+ bags','🚐','Manual','Diesel',50, CURRENT_TIMESTAMP),

  ('bus','Bus',20,
   'Large groups and events',
   'Twenty seats for corporate offsites, pilgrimages and wedding parties.',
   '20+ bags','🚌','Manual','Diesel',60, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;