-- PostgreSQL-backed activation rate limiting
-- (docs/HERITAGE_V3_DECISIONS_LOG.md D-037 Section 11). Schema only in
-- this checkpoint — no repository, service, route, or feature code reads
-- or writes this table yet (D-034 Stage 5c/5d). Purely additive: a new
-- enum and a new table, no existing column, table, index, or constraint
-- is dropped, renamed, or destructively rewritten. Separately justified
-- and separately reviewed from the audit-log actor-kind migration
-- (20260827062426_portal_activation_audit_log_actor_kind) — two unrelated
-- schema areas, never bundled into one file, per D-037's own Constraint.

-- CreateEnum
CREATE TYPE "RateLimitDimension" AS ENUM ('SOURCE', 'TOKEN');

-- CreateTable
CREATE TABLE "rate_limit_bucket" (
    "id" TEXT NOT NULL,
    "dimension" "RateLimitDimension" NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_bucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_limit_bucket_windowStart_idx" ON "rate_limit_bucket"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_bucket_dimension_bucketKey_windowStart_key" ON "rate_limit_bucket"("dimension", "bucketKey", "windowStart");
