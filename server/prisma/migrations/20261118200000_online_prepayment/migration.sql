-- CreateEnum
CREATE TYPE "PaymentChannel" AS ENUM ('COUNTER', 'ONLINE');

-- CreateEnum
CREATE TYPE "OnlineOrderStatus" AS ENUM ('CREATED', 'PROCESSING', 'FAILED', 'PAID', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'NETBANKING';
ALTER TYPE "PaymentMethod" ADD VALUE 'WALLET';

-- AlterEnum
ALTER TYPE "RefundStatus" ADD VALUE 'REFUNDED';

-- DropForeignKey
ALTER TABLE "charges" DROP CONSTRAINT "charges_visit_id_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_visit_id_fkey";

-- AlterTable
ALTER TABLE "charges" ADD COLUMN     "appointment_id" UUID,
ALTER COLUMN "visit_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "appointment_id" UUID,
ALTER COLUMN "visit_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "channel" "PaymentChannel" NOT NULL DEFAULT 'COUNTER',
ADD COLUMN     "last4" TEXT,
ADD COLUMN     "provider" TEXT;

-- CreateTable
CREATE TABLE "online_payment_orders" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_order_id" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "attempt_key" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "OnlineOrderStatus" NOT NULL DEFAULT 'CREATED',
    "user_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "hold_id" TEXT NOT NULL,
    "doctor_id" UUID NOT NULL,
    "slot_start" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "catalogue_item_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "method" "PaymentMethod",
    "instrument" TEXT,
    "last4" TEXT,
    "failure_reason" TEXT,
    "appointment_id" UUID,
    "payment_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "online_payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "online_payment_orders_provider_order_id_key" ON "online_payment_orders"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_payment_orders_idempotency_key_key" ON "online_payment_orders"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "online_payment_orders_appointment_id_key" ON "online_payment_orders"("appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_payment_orders_payment_id_key" ON "online_payment_orders"("payment_id");

-- CreateIndex
CREATE INDEX "online_payment_orders_user_id_created_at_idx" ON "online_payment_orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "charges_appointment_id_idx" ON "charges"("appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_appointment_id_key" ON "invoices"("appointment_id");

-- CreateIndex
CREATE INDEX "payments_channel_received_at_idx" ON "payments"("channel", "received_at");

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A charge / invoice always hangs from a visit, or (prepaid online consultation, until check-in) from an appointment.
ALTER TABLE "charges" ADD CONSTRAINT "charges_visit_or_appointment" CHECK ("visit_id" IS NOT NULL OR "appointment_id" IS NOT NULL);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_visit_or_appointment" CHECK ("visit_id" IS NOT NULL OR "appointment_id" IS NOT NULL);
