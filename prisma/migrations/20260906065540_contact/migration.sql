-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('NEW', 'READ', 'RESPONDED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "mobile" VARCHAR(20) NOT NULL,
    "email" VARCHAR(180) NOT NULL,
    "topic" VARCHAR(120) NOT NULL,
    "message" TEXT NOT NULL,
    "status" "ContactStatus" NOT NULL DEFAULT 'NEW',
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contacts_status_idx" ON "contacts"("status");

-- CreateIndex
CREATE INDEX "contacts_created_at_idx" ON "contacts"("created_at");
