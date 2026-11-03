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
  decided_by TEXT,
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
  outcome TEXT NOT NULL, -- applied | refused | failed
  actor TEXT            -- who approved it (user name), or auto-apply
);

-- Key/value switches. writes_paused = '1' is the kill switch.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Devices subscribed to Web Push from the installed PWA.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  last_error TEXT
);

-- Every Claude API call: tokens and cost, for the daily budget and the Metrics screen.
CREATE TABLE IF NOT EXISTS claude_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  job TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL,
  stop_reason TEXT
);
CREATE INDEX IF NOT EXISTS claude_usage_at ON claude_usage (at);

-- Orders read nightly from the Fulfillment API (read-only), for sales metrics.
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  total REAL,
  fees REAL,
  currency TEXT,
  status TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT,
  quantity INTEGER,
  price REAL,
  PRIMARY KEY (order_id, item_id)
);

-- Listing traffic for the last 7 days, read nightly from the Analytics API.
CREATE TABLE IF NOT EXISTS listing_traffic (
  item_id TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  views_7d INTEGER,
  impressions_7d INTEGER,
  PRIMARY KEY (item_id, taken_at)
);

-- The nightly health check's flags per listing (latest run only is shown).
CREATE TABLE IF NOT EXISTS health_flags (
  item_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  flag TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (item_id, checked_at, flag)
);

-- Buyer questions and Best Offers already seen by the 15-minute poll, so each is drafted once.
CREATE TABLE IF NOT EXISTS buyer_messages (
  message_id TEXT PRIMARY KEY,
  item_id TEXT,
  sender TEXT,
  body TEXT,
  received_at INTEGER NOT NULL,
  proposal_id TEXT
);
CREATE TABLE IF NOT EXISTS best_offers (
  best_offer_id TEXT PRIMARY KEY,
  item_id TEXT,
  buyer TEXT,
  price REAL,
  seen_at INTEGER NOT NULL,
  proposal_id TEXT
);

-- People (docs/security.md): K as owner and at most two managers, each with passkeys.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,            -- owner | manager
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  is_test INTEGER NOT NULL DEFAULT 0  -- the Sandbox-only key login; never counts toward the three
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,           -- passkey credential ID (base64url)
  user_id TEXT NOT NULL,
  alg INTEGER NOT NULL,          -- -7 ES256 | -257 RS256
  public_key TEXT NOT NULL,      -- JWK
  sign_count INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,      -- SHA-256 of the cookie token; the token itself is never stored
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  must_add_passkey INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,         -- register | add | login
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_attempts (
  key TEXT NOT NULL,             -- ip:<address> | setup
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_attempts_key ON auth_attempts (key, at);

-- Third-party sold-price data (docs/sold-price-data.md): monthly usage against each provider's hard cap,
-- and a 30-day cache so the same search never spends twice.
CREATE TABLE IF NOT EXISTS solddata_usage (
  provider TEXT NOT NULL,        -- trawl | compsapi
  month TEXT NOT NULL,           -- YYYY-MM (UTC)
  used INTEGER NOT NULL,         -- Trawl credits or CompsAPI requests
  PRIMARY KEY (provider, month)
);
CREATE TABLE IF NOT EXISTS solddata_cache (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  sales TEXT NOT NULL
);

-- The pricing engine (docs/pricing-engine.md).

-- Claude's identification of a listing (product, parts, searches), cached by title and condition.
CREATE TABLE IF NOT EXISTS item_identity (
  key TEXT PRIMARY KEY,
  item_id TEXT,
  identity TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- Daily matched active listings per search, for learning which prices sell.
CREATE TABLE IF NOT EXISTS market_snapshots (
  key TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  total REAL NOT NULL,
  grp TEXT NOT NULL,
  market REAL NOT NULL,
  share REAL NOT NULL,
  PRIMARY KEY (key, taken_at, item_id)
);

-- Every price decision: inputs, strategy and prediction, checked later against what happened.
CREATE TABLE IF NOT EXISTS price_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  at INTEGER NOT NULL,
  grp TEXT NOT NULL,
  strategy TEXT NOT NULL,
  price REAL,
  total REAL,
  market_price REAL,
  predicted_days REAL,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS price_decisions_item ON price_decisions (item_id, at);

-- Learned sale-model parameters per category group ("all" is the global fit).
CREATE TABLE IF NOT EXISTS pricing_params (
  grp TEXT PRIMARY KEY,
  tau REAL NOT NULL,
  alpha REAL NOT NULL,
  n INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Bundle and split suggestions across K's listings (advice only; K decides).
CREATE TABLE IF NOT EXISTS bundle_advice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- combine | split | run
  item_ids TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL           -- open | dismissed | replaced | done
);

-- The first-day audit's reports (src/firstday.ts), newest shown in the app.
CREATE TABLE IF NOT EXISTS audit_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  env TEXT NOT NULL,
  report TEXT NOT NULL
);
