-- Medicines that existed before per-item GST (billing_accounts) got the column default of 0%.
-- Bring them to the medicine default of 5%, matching items created by the pharmacy since.
UPDATE "service_catalogue" SET "tax_percent" = 5 WHERE "category" = 'MEDICINE' AND "tax_percent" = 0;
