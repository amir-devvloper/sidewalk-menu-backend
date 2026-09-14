-- Adds an order-level "customer note" field (separate from the existing
-- per-item notes), e.g. "بدون پیاز", "زنگ نزنید در بزنید".
-- Run this once against the Supabase project (SQL editor or psql).

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS customer_note text;
