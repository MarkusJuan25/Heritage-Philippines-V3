-- AlterTable
ALTER TABLE "proposal_version" ADD COLUMN     "content" TEXT;

-- Hand-written: CHECK constraint permitting NULL (any pre-existing row,
-- since no application writer for this column existed before this
-- migration) while forbidding an all-whitespace, non-NULL content value
-- (D-027 §1). The 20,000-character maximum is application-layer
-- validation only and is deliberately not enforced here.
ALTER TABLE "proposal_version"
ADD CONSTRAINT "proposal_version_content_nonblank"
CHECK ("content" IS NULL OR btrim("content") <> '');
