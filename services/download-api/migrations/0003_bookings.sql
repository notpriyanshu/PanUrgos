-- Enterprise call bookings from panurgos.com/enterprise.
CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_start INTEGER NOT NULL UNIQUE,   -- UTC ms; UNIQUE means a slot can only be booked once
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL,
  company    TEXT    NOT NULL,
  size       TEXT,
  topic      TEXT,
  tz         TEXT,                      -- the visitor's timezone, for the confirmation email
  created_at INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'booked'
);
CREATE INDEX IF NOT EXISTS bookings_email ON bookings(email);
