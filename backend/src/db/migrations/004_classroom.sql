-- Assignments a professor sets in a league, graded automatically from each student's
-- fills and equity history. `target` means:
--   return_at_least   basis points of return (500 = 5%)
--   trades_at_least   number of fills
--   drawdown_at_most  basis points of max drawdown
--   use_order_type    0; the order type goes in order_type
CREATE TYPE assignment_kind AS ENUM ('return_at_least', 'trades_at_least', 'drawdown_at_most', 'use_order_type');

CREATE TABLE assignments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  league_id   bigint NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  kind        assignment_kind NOT NULL,
  target      bigint NOT NULL CHECK (target >= 0),
  order_type  text CHECK (order_type IN ('limit', 'market', 'stop', 'stop_limit', 'bracket')),
  due_at      timestamptz NOT NULL,
  created_by  bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'use_order_type') = (order_type IS NOT NULL))
);
CREATE INDEX assignments_league ON assignments (league_id, due_at);

-- The professor dashboard lists every fill in a league, newest first.
CREATE INDEX fills_portfolio_time ON fills (portfolio_id, created_at DESC);
