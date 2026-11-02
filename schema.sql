-- One row: the seller's eBay OAuth tokens and the scopes K consented to.
CREATE TABLE IF NOT EXISTS ebay_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_token TEXT NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  scopes TEXT NOT NULL
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

-- Every change to eBay is a proposal first, applied only through the write gate (src/ebay/write.ts).
-- kind: price | revise | create_listing | end_listing | relist | promote | offer_to_watchers | message | best_offer_response | policy
-- status: pending | approved | applying | applied | rejected | expired | failed
-- dry_run = 1: created while WRITE_MODE=off; it can never be applied.
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  item_id TEXT,
  payload TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  result TEXT
);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals (status, created_at);

-- Every eBay write the gate allowed, refused or saw fail.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  env TEXT NOT NULL,
  proposal_id TEXT,
  call TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT,
  outcome TEXT NOT NULL -- applied | refused | failed
);

-- Key/value switches. writes_paused = '1' is the kill switch.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
