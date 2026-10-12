-- One row: the seller's eBay OAuth tokens.
CREATE TABLE IF NOT EXISTS ebay_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_token TEXT NOT NULL,
  refresh_expires_at INTEGER NOT NULL
);

-- Nightly snapshot of each active listing, for health scoring over time.
CREATE TABLE IF NOT EXISTS listing_snapshots (
  item_id TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  title TEXT,
  price REAL,
  currency TEXT,
  quantity_available INTEGER,
  watch_count INTEGER,
  view_count INTEGER,
  start_time TEXT,
  PRIMARY KEY (item_id, taken_at)
);

-- Per-item seller settings (floor price, collection-only).
CREATE TABLE IF NOT EXISTS item_settings (
  item_id TEXT PRIMARY KEY,
  floor_price REAL,
  collection_only INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

-- Anything that changes eBay or reaches a buyer is a proposal first.
-- kind: price | revise | promote | offer_to_watchers | message | best_offer_response
-- status: pending | approved | rejected | applied | failed
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  item_id TEXT,
  payload TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  result TEXT
);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals (status, created_at);
