-- Usernames are unique whatever their case, so "Alice" can't sit next to "alice" on a
-- leaderboard. (Email is already citext.) Names that already clash only in case keep
-- the oldest one as it is; the others get "_<id>" on the end (cut to fit 24 characters).
UPDATE users u SET username = left(u.username, 23 - length(u.id::text)) || '_' || u.id
WHERE EXISTS (
  SELECT 1 FROM users o WHERE lower(o.username) = lower(u.username) AND o.id < u.id
);

CREATE UNIQUE INDEX users_username_lower ON users (lower(username));
