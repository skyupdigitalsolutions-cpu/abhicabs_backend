-- The Notification model has been in schema.prisma for a long time, but no
-- migration ever created its table. On any database built from `migrate deploy`
-- (i.e. production) every notification write failed at runtime with:
--
--   The table `public.notifications` does not exist in the current database.
--
-- Local databases built with `prisma db push` had the table, which is why this
-- never showed in development.
--
-- Idempotent, so it is safe on a database where db push already created it.

CREATE TABLE IF NOT EXISTS "notifications" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID         NOT NULL,
  "title"      VARCHAR(200) NOT NULL,
  "body"       VARCHAR(1000),
  "type"       VARCHAR(32)  NOT NULL DEFAULT 'INFO',
  "read"       BOOLEAN      NOT NULL DEFAULT false,
  "link_to"    VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notifications_user_id_read_created_at_idx"
  ON "notifications" ("user_id", "read", "created_at");

CREATE INDEX IF NOT EXISTS "notifications_created_at_idx"
  ON "notifications" ("created_at");

-- Cascade matches `onDelete: Cascade` on the relation: deleting a user takes
-- their notifications with them rather than leaving orphans behind.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_user_id_fkey'
  ) THEN
    ALTER TABLE "notifications"
      ADD CONSTRAINT "notifications_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;