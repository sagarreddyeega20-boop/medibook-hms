-- DropIndex
DROP INDEX "invoices_visit_id_idx";

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "tax_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tax_percent" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "decision_note" TEXT,
ADD COLUMN     "requested_by_id" UUID;

-- CreateTable
CREATE TABLE "cash_reconciliations" (
    "id" UUID NOT NULL,
    "business_date" TEXT NOT NULL,
    "expected_cash_paise" INTEGER NOT NULL,
    "expected_upi_paise" INTEGER NOT NULL,
    "expected_card_paise" INTEGER NOT NULL,
    "counted_cash_paise" INTEGER NOT NULL,
    "difference_paise" INTEGER NOT NULL,
    "payment_count" INTEGER NOT NULL,
    "note" TEXT,
    "closed_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_reconciliations_business_date_key" ON "cash_reconciliations"("business_date");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_visit_id_key" ON "invoices"("visit_id");

-- CreateIndex
CREATE INDEX "refunds_status_idx" ON "refunds"("status");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Money sanity (payments and allocations are already checked in init): refunds positive; an invoice is never over-paid.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount_paise" > 0);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_within_total" CHECK ("paid_paise" >= 0 AND "paid_paise" <= "total_paise");
