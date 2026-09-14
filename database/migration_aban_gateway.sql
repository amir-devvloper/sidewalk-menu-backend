-- Aban Gateway payment fields for SideWalk orders.
-- Safe to run more than once in Supabase SQL Editor.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid',
    ADD COLUMN IF NOT EXISTS payment_invoice_id text,
    ADD COLUMN IF NOT EXISTS payment_url text,
    ADD COLUMN IF NOT EXISTS paid_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_invoice_id_unique
    ON orders (payment_invoice_id)
    WHERE payment_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_payment_status
    ON orders (payment_status);
