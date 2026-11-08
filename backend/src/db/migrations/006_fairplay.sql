-- Fair-play checks need to know who traded with whom and whether the price was fair.
-- Two fills with the same trade_id are the two sides of one trade (trade ids are unique
-- per engine, with the symbol in the top bits). ref_price is the middle of the book when
-- the fill was recorded, so a price far from it stands out. Older fills have none.
ALTER TABLE fills ADD COLUMN ref_price bigint;
CREATE INDEX fills_trade ON fills (trade_id);
CREATE INDEX orders_portfolio_time ON orders (portfolio_id, created_at);
