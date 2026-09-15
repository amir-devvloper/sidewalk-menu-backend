create table if not exists reservations (
 id uuid default gen_random_uuid() primary key,
 name text not null,
 phone text not null,
 guests integer not null,
 reservation_date date not null,
 reservation_time time not null,
 note text,
 amount integer default 0,
 payment_status text default 'pending',
 status text default 'pending_payment',
 payment_id text,
 created_at timestamptz default now()
);

create table if not exists reservation_settings (
 id uuid default gen_random_uuid() primary key,
 base_price integer default 100000,
 special_day_enabled boolean default true,
 special_day_percent integer default 60,
 event_enabled boolean default true,
 updated_at timestamptz default now()
);

create table if not exists reservation_events (
 id uuid default gen_random_uuid() primary key,
 title text not null,
 event_date date not null,
 start_time time,
 end_time time,
 price_percent integer default 100,
 active boolean default true,
 created_at timestamptz default now()
);
