-- KAN-34: configurable alert thresholds, alert history and automatic resolution.
-- Additive only: no table, column or row is dropped or deleted.

-- CreateEnum
CREATE TYPE "MetricType" AS ENUM ('CPU', 'Memory', 'Disk');

-- AlterTable
-- Existing alerts get createdAt = the time this migration runs (their real creation
-- time was never recorded).
ALTER TABLE "Alert" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AlertThreshold" (
    "idThreshold" TEXT NOT NULL,
    "metric" "MetricType" NOT NULL,
    "warning" DOUBLE PRECISION NOT NULL,
    "critical" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "serverId" TEXT NOT NULL,

    CONSTRAINT "AlertThreshold_pkey" PRIMARY KEY ("idThreshold")
);

-- CreateIndex
CREATE INDEX "Alert_serverId_createdAt_idx" ON "Alert"("serverId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertThreshold_serverId_metric_key" ON "AlertThreshold"("serverId", "metric");

-- AddForeignKey
ALTER TABLE "AlertThreshold" ADD CONSTRAINT "AlertThreshold_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("idServer") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below is hand-written SQL that Prisma's schema language cannot express.
-- ---------------------------------------------------------------------------

-- Data fix-up 1: alerts that were already Resolved have no recorded resolution time.
-- Use createdAt (the migration time) so that every Resolved alert has a resolvedAt.
UPDATE "Alert" SET "resolvedAt" = "createdAt" WHERE "status" = 'Resolved' AND "resolvedAt" IS NULL;

-- Data fix-up 2: before at most one Active alert per (server, type) can be enforced,
-- any existing duplicates must go. The most severe one is kept Active (ties: lowest
-- idAlert); the others are marked Resolved, never deleted.
WITH ranked AS (
    SELECT "idAlert",
           ROW_NUMBER() OVER (
               PARTITION BY "serverId", "type"
               ORDER BY CASE "severity" WHEN 'Critical' THEN 0 WHEN 'Warning' THEN 1 ELSE 2 END, "idAlert"
           ) AS rn
    FROM "Alert"
    WHERE "status" = 'Active'
)
UPDATE "Alert"
SET "status" = 'Resolved', "resolvedAt" = CURRENT_TIMESTAMP
FROM ranked
WHERE "Alert"."idAlert" = ranked."idAlert" AND ranked.rn > 1;

-- Concurrency guard: the database itself refuses a second Active alert of the same
-- type for a server, whatever the application does. Resolved alerts are unrestricted,
-- so history can hold any number of them.
CREATE UNIQUE INDEX "Alert_one_active_per_server_type" ON "Alert"("serverId", "type") WHERE "status" = 'Active';

-- Integrity: an alert is Resolved exactly when it has a resolution time.
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_resolved_consistency"
    CHECK (("status" = 'Resolved') = ("resolvedAt" IS NOT NULL));

-- Integrity: thresholds are percentages and critical is strictly above warning.
ALTER TABLE "AlertThreshold" ADD CONSTRAINT "AlertThreshold_range_check"
    CHECK ("warning" >= 0 AND "warning" <= 100 AND "critical" >= 0 AND "critical" <= 100 AND "critical" > "warning");
