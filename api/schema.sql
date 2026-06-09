CREATE TABLE IF NOT EXISTS subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,
  band_name     TEXT NOT NULL,
  band_lower    TEXT NOT NULL,
  confirm_token TEXT NOT NULL UNIQUE,
  unsub_token   TEXT NOT NULL UNIQUE,
  confirmed     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sub_email_band ON subscriptions (email, band_lower);
CREATE INDEX IF NOT EXISTS idx_sub_confirm    ON subscriptions (confirm_token);
CREATE INDEX IF NOT EXISTS idx_sub_unsub      ON subscriptions (unsub_token);

CREATE TABLE IF NOT EXISTS notified (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,
  band_lower  TEXT NOT NULL,
  show_date   TEXT NOT NULL,
  venue_lower TEXT NOT NULL,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (email, band_lower, show_date, venue_lower)
);

CREATE INDEX IF NOT EXISTS idx_notified_lookup ON notified (email, band_lower, show_date, venue_lower);
