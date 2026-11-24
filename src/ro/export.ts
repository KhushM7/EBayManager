import type { Env } from "../env";
import { accuracyTable, healthTable, listingsDailyTable, listingsTable, priceDecisionsTable, proposalsTable, salesTable, spendTable } from "./tables";

// The nightly export for Power BI (docs/power-platform.md, Phase 1): each read-only table as a CSV file. The
// 02:00 run writes them to the private `exports` Blob container; /api/ro/export/<name>.csv serves the stored
// file (or builds it there and then if the nightly hasn't written one). The same tables, so the same rule: no
// buyer personal data.

/** Two years: K's imported sales go back to 2025. */
const EXPORT_DAYS = 730;
const DAY = 86_400_000;

type Row = Record<string, unknown>;

/** Every export: its columns, in order, and how its rows are read. Column names are the Power BI field names. */
export const EXPORTS: Record<string, { columns: string[]; rows: (env: Env, now: number) => Promise<object[]> }> = {
  listings: {
    columns: ["item_id", "title", "price", "currency", "quantity", "watchers", "views_7d", "impressions_7d", "start_date", "days_listed", "health_flags", "waiting_changes", "snapshot_at"],
    rows: (env, now) => listingsTable(env, now),
  },
  listings_daily: {
    columns: ["date", "active_listings", "asking_total", "watchers"],
    rows: (env, now) => listingsDailyTable(env, now - EXPORT_DAYS * DAY),
  },
  sales: {
    columns: ["sale_id", "sold_at", "item_id", "title", "quantity", "item_price", "line_total", "days_to_sell", "source"],
    rows: (env, now) => salesTable(env, now - EXPORT_DAYS * DAY),
  },
  proposals: {
    columns: ["id", "kind", "kind_label", "item_id", "item_title", "status", "outcome", "applied", "dry_run", "created_at", "decided_at", "expires_at", "hours_to_decide", "decided_by", "old_price", "new_price"],
    rows: async (env, now) =>
      (await proposalsTable(env, now - EXPORT_DAYS * DAY)).map((p) => ({ ...p, old_price: p.details.oldPrice ?? p.details.price ?? p.details.listPrice ?? null, new_price: p.details.newPrice ?? p.details.offerPrice ?? p.details.counterPrice ?? null })),
  },
  price_accuracy: {
    columns: ["sale_id", "sold_at", "item_id", "title", "group", "strategy", "predicted_at", "days_before_sale", "predicted_price", "market_price", "sold_price", "error", "abs_pct_error"],
    rows: async (env, now) => (await accuracyTable(env, now - EXPORT_DAYS * DAY)).rows,
  },
  price_decisions: {
    columns: ["item_id", "decided_at", "group", "strategy", "suggested_price", "suggested_total_with_postage", "market_price", "predicted_days"],
    rows: (env, now) => priceDecisionsTable(env, now - EXPORT_DAYS * DAY),
  },
  health_flags: {
    columns: ["date", "item_id", "title", "flag", "detail"],
    rows: (env, now) => healthTable(env, now - EXPORT_DAYS * DAY),
  },
  claude_spend: {
    columns: ["date", "job", "model", "calls", "input_tokens", "output_tokens", "cost_usd", "daily_budget_usd"],
    rows: (env, now) => spendTable(env, now - EXPORT_DAYS * DAY),
  },
};

/**
 * One CSV cell (RFC 4180). Text that a spreadsheet would run as a formula (it starts with = + - or @) gets a
 * leading apostrophe: listing titles are typed by people, and these files may be opened in Excel.
 */
export function csvCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (columns: string[], rows: object[]) => [columns.join(","), ...(rows as Row[]).map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";

export async function buildExport(env: Env, name: string, now = Date.now()): Promise<string | null> {
  const e = EXPORTS[name];
  return e ? toCsv(e.columns, await e.rows(env, now)) : null;
}

const key = (name: string) => `${name}.csv`;
const enc = new TextEncoder();

/** The nightly step: every export written to the exports store. Without one (tests, local runs) it's skipped. */
export async function writeExports(env: Env, now = Date.now()): Promise<string> {
  if (!env.exports) return "skipped: no export storage";
  const files: Record<string, number> = {};
  for (const name of Object.keys(EXPORTS)) {
    const csv = (await buildExport(env, name, now))!;
    await env.exports.put(key(name), enc.encode(csv), "text/csv; charset=utf-8");
    files[name] = csv.split("\r\n").length - 2;
  }
  await env.exports.put("manifest.json", enc.encode(JSON.stringify({ at: now, files })), "application/json");
  return `${Object.keys(files).length} files`;
}

/** The stored file if the nightly wrote one, else built now. `live` always builds. */
export async function readExport(env: Env, name: string, live = false): Promise<{ csv: string; exportedAt: number } | null> {
  if (!EXPORTS[name]) return null;
  if (!live && env.exports) {
    try {
      const [file, manifest] = await Promise.all([env.exports.get(key(name)), env.exports.get("manifest.json")]);
      const at = manifest ? Number(JSON.parse(new TextDecoder().decode(manifest)).at) : NaN;
      if (file && Number.isFinite(at)) return { csv: new TextDecoder().decode(file), exportedAt: at };
    } catch {
      // Storage can't be read: build it now instead.
    }
  }
  const now = Date.now();
  return { csv: (await buildExport(env, name, now))!, exportedAt: now };
}
