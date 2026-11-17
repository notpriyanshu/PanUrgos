-- PanUrgos download accounts. Minimal by design: no IPs, no user agents, no cookies.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  platform      TEXT    NOT NULL,            -- last platform asked for: win | mac | linux
  notify_opt_in INTEGER NOT NULL DEFAULT 0,  -- may we email when a build for their platform ships
  created_at    INTEGER NOT NULL,
  verified_at   INTEGER,
  last_sent_at  INTEGER,                     -- cooldown for sign-in emails
  sends_day     TEXT,                        -- YYYY-MM-DD of the counter below
  sends_today   INTEGER NOT NULL DEFAULT 0
);

-- kind = 'link' (emailed, single use, 30 min) or 'file' (download ticket, few uses, 15 min)
CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT    PRIMARY KEY,            -- SHA-256 of the token; the token itself is never stored
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT    NOT NULL,
  platform   TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  uses_left  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS tokens_expiry ON tokens(expires_at);

CREATE TABLE IF NOT EXISTS downloads (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users(id),
  platform TEXT    NOT NULL,
  version  TEXT,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS downloads_at ON downloads(at);
