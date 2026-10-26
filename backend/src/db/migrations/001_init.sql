-- Accounts, sessions, orders and fills. Cash and positions come with the ledger.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role AS ENUM ('student', 'professor', 'admin');

-- users.id doubles as the account id on the exchange, so it has to fit in a u32
-- and stay below the range the market simulator uses for bots (900001+).
CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (id < 900000),
  email         citext NOT NULL UNIQUE,
  username      text NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_]{3,24}$'),
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'student',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh tokens rotate on every use. All tokens from one login share a family;
-- if an old token is ever presented again, the whole family is revoked.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  user_agent  text,
  ip          inet
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

CREATE TABLE symbols (
  id        integer PRIMARY KEY,
  ticker    text NOT NULL UNIQUE,
  company   text NOT NULL,
  sector    text NOT NULL,
  ref_price bigint NOT NULL
);

INSERT INTO symbols VALUES
  (0, 'NOVA', 'Nova Robotics', 'tech', 14000),
  (1, 'HELX', 'Helix Therapeutics', 'biotech', 5800),
  (2, 'ORBT', 'Orbit Launch Systems', 'aerospace', 31000),
  (3, 'KILN', 'Kiln Ceramics', 'materials', 2500),
  (4, 'VYNE', 'Vyne Foods', 'consumer', 9700),
  (5, 'QSTR', 'Quasar Mobile', 'telecom', 1200),
  (6, 'BRKL', 'Brookline Bank', 'finance', 7450),
  (7, 'MESA', 'Mesa Energy', 'energy', 18800);

CREATE TYPE order_side AS ENUM ('buy', 'sell');
CREATE TYPE order_type AS ENUM ('limit', 'market', 'stop', 'stop_limit');
CREATE TYPE order_tif AS ENUM ('gtc', 'ioc', 'fok');
CREATE TYPE order_status AS ENUM ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected');

-- orders.id is also the cl_ord_id sent to the exchange.
CREATE TABLE orders (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(id),
  symbol_id       integer NOT NULL REFERENCES symbols(id),
  side            order_side NOT NULL,
  type            order_type NOT NULL,
  tif             order_tif NOT NULL,
  price           bigint,
  stop_price      bigint,
  qty             integer NOT NULL CHECK (qty > 0),
  leaves          integer NOT NULL,
  filled_qty      integer NOT NULL DEFAULT 0,
  status          order_status NOT NULL DEFAULT 'pending',
  engine_order_id bigint UNIQUE,
  reject_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_status ON orders (user_id, status);

CREATE TABLE fills (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   bigint NOT NULL REFERENCES orders(id),
  user_id    bigint NOT NULL REFERENCES users(id),
  symbol_id  integer NOT NULL REFERENCES symbols(id),
  side       order_side NOT NULL,
  price      bigint NOT NULL,
  qty        integer NOT NULL,
  trade_id   bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_id, order_id)
);
CREATE INDEX fills_user ON fills (user_id, created_at DESC);

-- Append-only record of every security-relevant action.
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint REFERENCES users(id),
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user ON audit_log (user_id, created_at DESC);
