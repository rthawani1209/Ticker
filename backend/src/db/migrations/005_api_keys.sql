-- API keys for trading bots. Only a hash of the secret is stored; the prefix is
-- the public part used to find the row and to show the key in lists.
CREATE TABLE api_keys (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league_id         bigint REFERENCES leagues(id) ON DELETE CASCADE, -- NULL = practice
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  prefix            text NOT NULL UNIQUE,
  secret_hash       bytea NOT NULL,
  max_order_qty     integer NOT NULL DEFAULT 1000 CHECK (max_order_qty BETWEEN 1 AND 100000),
  orders_per_second integer NOT NULL DEFAULT 5 CHECK (orders_per_second BETWEEN 1 AND 20),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  revoked_at        timestamptz
);
CREATE INDEX api_keys_user ON api_keys (user_id) WHERE revoked_at IS NULL;

-- Which key (if any) sent each order, so revoking a key can pull its orders.
ALTER TABLE orders ADD COLUMN api_key_id bigint REFERENCES api_keys(id);
CREATE INDEX orders_api_key_open ON orders (api_key_id)
  WHERE api_key_id IS NOT NULL AND status IN ('pending', 'open', 'partially_filled');

-- Switches an admin can flip at runtime, shared by every gateway.
CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO settings (key, value) VALUES ('bots_enabled', 'true');
