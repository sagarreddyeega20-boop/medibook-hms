-- A booking made from a doctor's referral points back to the REFERRAL order it fulfils.
-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "source_order_id" UUID;

-- CreateIndex
CREATE INDEX "appointments_source_order_id_idx" ON "appointments"("source_order_id");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_source_order_id_fkey" FOREIGN KEY ("source_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
