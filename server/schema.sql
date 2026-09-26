-- Imaq PostgreSQL schema (Railway PostgreSQL in production).
-- Idempotent: can run on every start.

CREATE TABLE IF NOT EXISTS trucks (
  id               TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  capacity_l       INTEGER NOT NULL CHECK (capacity_l > 0),
  current_water_l  INTEGER NOT NULL CHECK (current_water_l >= 0),
  status           TEXT NOT NULL DEFAULT 'IN_SERVICE' CHECK (status IN ('IN_SERVICE', 'OUT_OF_SERVICE')),
  trip             INTEGER NOT NULL DEFAULT 1,
  status_changed_at TIMESTAMPTZ,
  archived         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS households (
  id                     TEXT PRIMARY KEY,
  display_name           TEXT NOT NULL,
  residents_count        INTEGER NOT NULL CHECK (residents_count > 0),
  tank_capacity_l        INTEGER NOT NULL CHECK (tank_capacity_l > 0),
  tank_height_cm         NUMERIC(6,1) NOT NULL CHECK (tank_height_cm > 0),
  configured_daily_use_l INTEGER NOT NULL CHECK (configured_daily_use_l > 0),
  vulnerability_flag     TEXT,
  assigned_truck_id      TEXT REFERENCES trucks(id),
  delivery_interval_days INTEGER NOT NULL DEFAULT 2,
  water_baseline         JSONB,
  low_water_reported     BOOLEAN NOT NULL DEFAULT FALSE,
  archived               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prototype: role selection stands in for sign-in. This table is ready for real auth later.
CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('resident', 'driver', 'admin')),
  household_id TEXT REFERENCES households(id),
  truck_id     TEXT REFERENCES trucks(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensor_devices (
  id               TEXT PRIMARY KEY,
  serial_number    TEXT NOT NULL UNIQUE,
  household_id     TEXT REFERENCES households(id),
  status           TEXT NOT NULL DEFAULT 'UNASSIGNED' CHECK (status IN ('ONLINE', 'STALE', 'OFFLINE', 'SERVICE_REQUIRED', 'UNASSIGNED')),
  battery_percent  NUMERIC(5,1),
  firmware_version TEXT,
  last_seen        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sensor_readings (
  id               BIGSERIAL PRIMARY KEY,
  sensor_device_id TEXT NOT NULL REFERENCES sensor_devices(id),
  recorded_at      TIMESTAMPTZ NOT NULL,
  distance_cm      NUMERIC(7,1) NOT NULL,
  turbidity        NUMERIC(8,3),
  conductivity     NUMERIC(8,1),
  temperature      NUMERIC(5,2),
  battery_percent  NUMERIC(5,1),
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sensor_readings_device_time ON sensor_readings (sensor_device_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  id           BIGSERIAL PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  truck_id     TEXT NOT NULL REFERENCES trucks(id),
  litres       INTEGER NOT NULL CHECK (litres > 0),
  delivered_at TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deliveries_household_time ON deliveries (household_id, delivered_at DESC);

CREATE TABLE IF NOT EXISTS low_water_reports (
  id           BIGSERIAL PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS low_water_open ON low_water_reports (household_id) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS alerts (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('advisory', 'delay', 'conserve', 'all_clear', 'ops_truck_down')),
  title       TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  audience    TEXT NOT NULL DEFAULT 'households' CHECK (audience IN ('households', 'municipality')),
  truck_id    TEXT,
  affected    JSONB,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);

-- Small key/value store for community settings (village water, stops per truck, seed time).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
