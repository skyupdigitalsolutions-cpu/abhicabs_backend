-- WhatsApp bot chat state: three tables (sessions, processed messages, abandoned bookings).
-- Safe in every case:
--   * If the three tables already exist (you never ran the one-table migration), nothing changes.
--   * If you did run the one-table migration, the rows in whatsapp_records are copied back
--     into the three tables and whatsapp_records is dropped.
-- No booking, payment, customer or vehicle data is touched.

CREATE TABLE IF NOT EXISTS "whatsapp_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "whatsapp_number" VARCHAR(20) NOT NULL,
  "user_id" UUID,
  "language" VARCHAR(8),
  "state" VARCHAR(60) NOT NULL DEFAULT 'LANGUAGE_SELECTION',
  "previous_state" VARCHAR(60),
  "draft" JSONB NOT NULL DEFAULT '{}',
  "active_booking_id" UUID,
  "active_payment_id" UUID,
  "pending_idempotency_key" TEXT,
  "pending_options_map" JSONB NOT NULL DEFAULT '{}',
  "human_handoff" BOOLEAN NOT NULL DEFAULT false,
  "handoff_reason" TEXT,
  "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_sessions_whatsapp_number_key" ON "whatsapp_sessions"("whatsapp_number");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_last_message_at_idx" ON "whatsapp_sessions"("last_message_at");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_user_id_idx" ON "whatsapp_sessions"("user_id");

CREATE TABLE IF NOT EXISTS "whatsapp_processed_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "whatsapp_message_id" VARCHAR(160) NOT NULL,
  "whatsapp_number" VARCHAR(30) NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_processed_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_processed_messages_whatsapp_message_id_key" ON "whatsapp_processed_messages"("whatsapp_message_id");
CREATE INDEX IF NOT EXISTS "whatsapp_processed_messages_processed_at_idx" ON "whatsapp_processed_messages"("processed_at");

CREATE TABLE IF NOT EXISTS "whatsapp_abandoned_bookings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "whatsapp_number" VARCHAR(30) NOT NULL,
  "session_id" UUID NOT NULL,
  "snapshot" JSONB NOT NULL,
  "abandoned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "follow_up_sent_at" TIMESTAMP(3),
  "recovered" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_abandoned_bookings_pkey" PRIMARY KEY ("id")
);

-- Only when the one-table version was applied: move its rows back, then remove it.
DO $$
BEGIN
  IF to_regclass('public.whatsapp_records') IS NOT NULL THEN
    INSERT INTO "whatsapp_sessions"
      ("id", "whatsapp_number", "user_id", "language", "state", "previous_state", "draft", "active_booking_id",
       "active_payment_id", "pending_idempotency_key", "pending_options_map", "human_handoff", "handoff_reason",
       "last_message_at", "expires_at", "created_at", "updated_at")
    SELECT "id", LEFT("key", 20), "user_id", LEFT("data"->>'language', 8), COALESCE("state", 'LANGUAGE_SELECTION'),
           "data"->>'previousState', COALESCE("data"->'draft', '{}'::jsonb),
           NULLIF("data"->>'activeBookingId', '')::uuid, NULLIF("data"->>'activePaymentId', '')::uuid,
           "data"->>'pendingIdempotencyKey', COALESCE("data"->'pendingOptionsMap', '{}'::jsonb),
           "human_handoff", "data"->>'handoffReason', "event_at",
           NULLIF("data"->>'expiresAt', '')::timestamp, "created_at", "updated_at"
    FROM "whatsapp_records" WHERE "kind" = 'SESSION'
    ON CONFLICT DO NOTHING;

    INSERT INTO "whatsapp_processed_messages" ("whatsapp_message_id", "whatsapp_number", "processed_at")
    SELECT LEFT("key", 160), "whatsapp_number", "event_at"
    FROM "whatsapp_records" WHERE "kind" = 'MESSAGE'
    ON CONFLICT DO NOTHING;

    INSERT INTO "whatsapp_abandoned_bookings"
      ("whatsapp_number", "session_id", "snapshot", "abandoned_at", "follow_up_sent_at", "recovered", "created_at")
    SELECT "whatsapp_number", "key"::uuid, COALESCE("data"->'snapshot', '{}'::jsonb), "event_at", "handled_at", "done", "created_at"
    FROM "whatsapp_records" WHERE "kind" = 'ABANDONED'
    ON CONFLICT DO NOTHING;

    DROP TABLE "whatsapp_records";
  END IF;
END $$;
