-- Aban Gateway payment fields + human-readable code for reservations.
-- Safe to run more than once in Supabase SQL Editor.

ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS reservation_code text,
    ADD COLUMN IF NOT EXISTS payment_invoice_id text,
    ADD COLUMN IF NOT EXISTS payment_url text,
    ADD COLUMN IF NOT EXISTS paid_at timestamptz;

-- Backfill a code for any rows created before this migration so the
-- unique index below doesn't fail on NULLs.
UPDATE reservations
    SET reservation_code = 'RSV-LEGACY-' || substr(id::text, 1, 8)
    WHERE reservation_code IS NULL;

ALTER TABLE reservations
    ALTER COLUMN reservation_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_code_unique
    ON reservations (reservation_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_payment_invoice_id_unique
    ON reservations (payment_invoice_id)
    WHERE payment_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations (status);
CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations (reservation_date);
CREATE INDEX IF NOT EXISTS idx_reservations_created_at ON reservations (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reservation_events_date ON reservation_events (event_date);

-- Reservation_settings should only ever hold a single row (read with
-- `.limit(1).single()` in the backend); nothing enforces that today, so
-- keep it in mind if you ever insert a second row from the SQL editor.
