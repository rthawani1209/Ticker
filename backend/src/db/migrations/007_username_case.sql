-- Usernames are unique whatever their case, so "Alice" can't sit next to "alice" on a
-- leaderboard. (Email is already citext.)
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));
