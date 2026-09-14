-- Discount code system.
-- Safe to run more than once in the Supabase SQL editor.

-- Needed for gen_random_uuid() below (already enabled on most Supabase
-- projects, but IF NOT EXISTS makes this safe either way).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS discount_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Always stored upper-cased by the backend, e.g. "WEEKEND20".
    code text NOT NULL UNIQUE,
    discount_percent numeric NOT NULL,
    min_order_amount numeric NOT NULL DEFAULT 0,
    starts_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discount_codes_is_active ON discount_codes (is_active);

-- Snapshot of the discount actually applied to an order, so editing or
-- deleting a discount code later never changes the amount a past order
-- was charged.
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS subtotal numeric,
    ADD COLUMN IF NOT EXISTS discount_code text,
    ADD COLUMN IF NOT EXISTS discount_percent numeric,
    ADD COLUMN IF NOT EXISTS discount_amount numeric NOT NULL DEFAULT 0;
