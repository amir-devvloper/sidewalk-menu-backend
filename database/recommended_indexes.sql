-- Run in Supabase SQL editor after confirming the columns exist.
-- These indexes reduce order-code collision risk and improve admin queries.
create unique index if not exists orders_order_code_unique
    on public.orders (order_code);

create index if not exists orders_created_at_idx
    on public.orders (created_at desc);

create index if not exists products_created_at_idx
    on public.products (created_at desc);
