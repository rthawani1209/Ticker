-- The ledger: leagues, one portfolio per user per league, cash and positions.
-- A portfolio's id is its account number on the exchange, so self-trade prevention
-- and positions are per league, not per person.

CREATE TABLE leagues (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL CHECK (length(name) BETWEEN 3 AND 60),
  owner_id       bigint REFERENCES users(id),
  invite_code    text UNIQUE,
  is_practice    boolean NOT NULL DEFAULT false,
  starts_at      timestamptz NOT NULL DEFAULT now(),
  ends_at        timestamptz CHECK (ends_at IS NULL OR ends_at > starts_at),
  starting_cash  bigint NOT NULL CHECK (starting_cash > 0),
  -- rules
  commission_cents integer NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),  -- per fill
  commission_bps   integer NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 1000),
  max_position     integer CHECK (max_position > 0),  -- shares per stock, long or short; NULL = no limit
  allow_short      boolean NOT NULL DEFAULT true,
  margin_bps       integer NOT NULL DEFAULT 15000 CHECK (margin_bps >= 10000),  -- cash held against shorts
  allowed_types    order_type[] NOT NULL DEFAULT '{limit,market,stop,stop_limit}',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Everyone is in the practice league: $100,000, no end date.
INSERT INTO leagues (name, is_practice, starting_cash) VALUES ('Practice', true, 10000000);

CREATE TABLE portfolios (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (id < 900000),
  league_id  bigint NOT NULL REFERENCES leagues(id),
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cash       bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (league_id, user_id)
);

CREATE TABLE positions (
  portfolio_id bigint NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  symbol_id    integer NOT NULL REFERENCES symbols(id),
  qty          integer NOT NULL DEFAULT 0,  -- negative = short
  cost         bigint NOT NULL DEFAULT 0,   -- cost basis of the open quantity, same sign as qty
  realized     bigint NOT NULL DEFAULT 0,   -- profit already locked in by closing trades
  PRIMARY KEY (portfolio_id, symbol_id)
);

-- Portfolio value over time, for return charts and the Sharpe ratio.
CREATE TABLE equity_snapshots (
  portfolio_id bigint NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  equity       bigint NOT NULL,
  PRIMARY KEY (portfolio_id, at)
);

-- Existing users and orders move into the practice league. Nothing was deployed before
-- the ledger, so fills from before this migration aren't replayed into cash and positions.
INSERT INTO portfolios (league_id, user_id, cash)
  SELECT (SELECT id FROM leagues WHERE is_practice), id, 10000000 FROM users;

ALTER TABLE orders ADD COLUMN portfolio_id bigint REFERENCES portfolios(id);
UPDATE orders o SET portfolio_id = p.id FROM portfolios p WHERE p.user_id = o.user_id;
ALTER TABLE orders ALTER COLUMN portfolio_id SET NOT NULL;
CREATE INDEX orders_portfolio_status ON orders (portfolio_id, status);

ALTER TABLE fills ADD COLUMN portfolio_id bigint REFERENCES portfolios(id);
ALTER TABLE fills ADD COLUMN commission bigint NOT NULL DEFAULT 0;
UPDATE fills f SET portfolio_id = o.portfolio_id FROM orders o WHERE o.id = f.order_id;
ALTER TABLE fills ALTER COLUMN portfolio_id SET NOT NULL;
CREATE INDEX fills_portfolio ON fills (portfolio_id, id);
