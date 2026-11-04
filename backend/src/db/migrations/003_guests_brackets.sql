-- Guest accounts (try the market without signing up) and bracket orders.

-- A guest has no email or password, only the practice portfolio. The check compares
-- the role as text because a new enum value can't be used in the transaction that adds it.
ALTER TYPE user_role ADD VALUE 'guest';
ALTER TABLE users ALTER COLUMN email DROP NOT NULL, ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_guest_or_login
  CHECK (role::text = 'guest' OR (email IS NOT NULL AND password_hash IS NOT NULL));

-- A bracket is an entry order plus two exits that go out once the entry is done:
-- a take-profit limit and a stop-loss stop, for the filled quantity. The first exit
-- to fill cancels the other.
ALTER TABLE orders
  ADD COLUMN take_profit bigint CHECK (take_profit > 0),
  ADD COLUMN stop_loss   bigint CHECK (stop_loss > 0),
  ADD COLUMN exits_sent  boolean NOT NULL DEFAULT false,
  ADD COLUMN parent_id   bigint REFERENCES orders(id);
CREATE INDEX orders_parent ON orders (parent_id) WHERE parent_id IS NOT NULL;
