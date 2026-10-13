-- Review Q4FIX-N1: a saved-card charge Square completed after Oasis closed it ("Not charged (checked Square)" or the job's NOT_SENT).
-- The payment is recorded on the invoice as before; this marks the charge so the invoice's "Overpaid via Square" alert says why
-- (the desk may have collected the money again meanwhile).
alter table square_charges add column charged_after_close_at timestamptz;
