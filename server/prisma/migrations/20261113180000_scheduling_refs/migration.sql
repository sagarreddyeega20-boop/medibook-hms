-- Scheduling: human-readable booking reference (APT-000123) used at reception and by the booking assistant.
ALTER TABLE "appointments" ADD COLUMN "ref" TEXT;
UPDATE "appointments" SET "ref" = 'APT-' || upper(substr(replace("id"::text, '-', ''), 1, 8)) WHERE "ref" IS NULL;
ALTER TABLE "appointments" ALTER COLUMN "ref" SET NOT NULL;
CREATE UNIQUE INDEX "appointments_ref_key" ON "appointments"("ref");
