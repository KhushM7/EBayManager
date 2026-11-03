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
