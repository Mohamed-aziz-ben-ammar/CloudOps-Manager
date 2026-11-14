-- KAN-37/KAN-38: index for the dashboard time-series query (samples of a set of servers
-- within a time range). Additive only: no table, column or row is changed or deleted.
--
-- A plain CREATE INDEX takes a lock that blocks writes to "Metric" (including the metric
-- simulator) while the index is built. That is brief for a modest table; on a very large
-- one, run the migration in a quiet period. CREATE INDEX CONCURRENTLY cannot be used here
-- because Prisma runs a migration inside a transaction.

-- CreateIndex
CREATE INDEX "Metric_serverId_timestamp_idx" ON "Metric"("serverId", "timestamp");
