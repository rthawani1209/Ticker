-- Login attempts are counted by the email typed, so an address with no account gets
-- the same lockout as one with an account, and the 429 says nothing about which it is.
CREATE INDEX audit_log_login_email ON audit_log ((detail->>'email'), created_at)
  WHERE action = 'login_attempt';
