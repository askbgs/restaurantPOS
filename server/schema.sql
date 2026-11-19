-- Ember & Bao Restaurant POS schema (PostgreSQL)
-- All money is stored as integer cents.

CREATE TABLE IF NOT EXISTS staff (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  initials    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'Server',      -- Captain, Server, Cashier, Kitchen, Manager
  pin_hash    TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  staff_id    INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS areas (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL,
  short  TEXT NOT NULL,
  sort   INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id       SERIAL PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,
  area_id  INT NOT NULL REFERENCES areas(id),
  seats    INT NOT NULL DEFAULT 2,
  sort     INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stations (
  id       SERIAL PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  printer  TEXT NOT NULL,
  sort     INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  default_course  TEXT NOT NULL DEFAULT 'main',   -- drink | starter | main | dessert
  sort            INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id           SERIAL PRIMARY KEY,
  category_id  INT NOT NULL REFERENCES categories(id),
  station_id   INT NOT NULL REFERENCES stations(id),
  name         TEXT NOT NULL,
  price_cents  INT NOT NULL,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  has_spice    BOOLEAN NOT NULL DEFAULT FALSE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort         INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item_addons (
  id           SERIAL PRIMARY KEY,
  item_id      INT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  price_cents  INT NOT NULL DEFAULT 0
);

CREATE SEQUENCE IF NOT EXISTS order_no_seq START 1040;
CREATE SEQUENCE IF NOT EXISTS kot_no_seq START 2200;

CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  order_no        INT NOT NULL DEFAULT nextval('order_no_seq'),
  type            TEXT NOT NULL CHECK (type IN ('dinein','takeaway','delivery','counter')),
  table_id        INT REFERENCES dining_tables(id),
  guests          INT NOT NULL DEFAULT 1,
  customer_name   TEXT,
  phone           TEXT,
  address         TEXT,
  staff_id        INT REFERENCES staff(id),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  bill_printed_at TIMESTAMPTZ,
  discount_pct    INT NOT NULL DEFAULT 0,
  service_on      BOOLEAN NOT NULL DEFAULT TRUE,
  tip_pct         INT NOT NULL DEFAULT 0,
  split_ways      INT NOT NULL DEFAULT 1,
  payment_method  TEXT,
  subtotal_cents  INT NOT NULL DEFAULT 0,
  discount_cents  INT NOT NULL DEFAULT 0,
  service_cents   INT NOT NULL DEFAULT 0,
  tax_cents       INT NOT NULL DEFAULT 0,
  tip_cents       INT NOT NULL DEFAULT 0,
  total_cents     INT NOT NULL DEFAULT 0
);
-- one open dine-in order per table
CREATE UNIQUE INDEX IF NOT EXISTS orders_open_table_uq
  ON orders(table_id) WHERE status = 'open' AND table_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kots (
  id          SERIAL PRIMARY KEY,
  kot_no      INT NOT NULL DEFAULT nextval('kot_no_seq'),
  order_id    INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  station_id  INT REFERENCES stations(id),          -- NULL = single combined ticket
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('held','new','cooking','ready','served')),
  is_addon    BOOLEAN NOT NULL DEFAULT FALSE,
  staff_id    INT REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  ready_at    TIMESTAMPTZ,
  served_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_items (
  id                SERIAL PRIMARY KEY,
  order_id          INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id      INT REFERENCES menu_items(id),
  station_id        INT REFERENCES stations(id),
  name              TEXT NOT NULL,
  qty               INT NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_cents  INT NOT NULL,
  addons            JSONB NOT NULL DEFAULT '[]',
  addons_cents      INT NOT NULL DEFAULT 0,
  spice             TEXT,
  course            TEXT NOT NULL DEFAULT 'main',
  note              TEXT,
  kot_id            INT REFERENCES kots(id) ON DELETE SET NULL,
  done              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS kots_status_idx ON kots(status);
CREATE INDEX IF NOT EXISTS orders_opened_idx ON orders(opened_at);
