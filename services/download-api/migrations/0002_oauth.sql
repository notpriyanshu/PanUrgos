-- Google / GitHub sign-in.
-- One-time "state" values that tie an OAuth round trip to the visitor who started it (10 minutes).
CREATE TABLE IF NOT EXISTS oauth_states (
  hash       TEXT    PRIMARY KEY,   -- SHA-256 of the state value
  provider   TEXT    NOT NULL,      -- google | github
  platform   TEXT    NOT NULL,
  notify     INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
-- How the user last signed in: email | google | github.
ALTER TABLE users ADD COLUMN via TEXT;
