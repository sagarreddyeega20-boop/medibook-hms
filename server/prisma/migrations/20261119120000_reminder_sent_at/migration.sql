-- Reminder emails (worker): when the 1-hour appointment reminder / the "referral not booked" reminder was queued.
-- Set in the same transaction as the email row, so a reminder is never queued twice.
ALTER TABLE "appointments" ADD COLUMN "reminder_sent_at" TIMESTAMPTZ(3);
ALTER TABLE "referrals" ADD COLUMN "reminder_sent_at" TIMESTAMPTZ(3);
