-- When a stop or stop-limit's stop price traded and it went live, so the blotter can
-- stop calling it a waiting stop.
ALTER TABLE orders ADD COLUMN triggered_at timestamptz;
