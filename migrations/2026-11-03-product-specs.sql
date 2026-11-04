-- Published specifications for an exactly identified product (src/specs.ts), each with its source page.
CREATE TABLE IF NOT EXISTS product_specs (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  at INTEGER NOT NULL,
  lookup TEXT NOT NULL
);
