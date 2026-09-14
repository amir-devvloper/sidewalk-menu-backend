-- Persist the delivery location (lat/lng) that the frontend already
-- collects and the backend already validates, but which was never being
-- saved to the database until now.
-- Safe to run more than once in the Supabase SQL editor.

ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS latitude double precision,
    ADD COLUMN IF NOT EXISTS longitude double precision,
    -- How the coordinates were obtained: 'gps' (browser geolocation),
    -- 'manual' (customer typed an address that was geocoded), or
    -- 'map' (customer dragged/tapped the marker on the map).
    ADD COLUMN IF NOT EXISTS location_source text;
