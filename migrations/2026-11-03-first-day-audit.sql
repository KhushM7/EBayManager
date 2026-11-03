-- Phase 7: the first-day audit's reports (src/firstday.ts). The reply style guide lives in settings.reply_style.
CREATE TABLE IF NOT EXISTS audit_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  env TEXT NOT NULL,
  report TEXT NOT NULL
);
