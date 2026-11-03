// eBay Seller Hub "all orders" report (CSV) -> K's past sales. eBay's APIs return only the last 90 days of
// orders, so older sales come from this report. Only seven columns are ever read; buyers' names, addresses,
// emails, phone numbers and notes are never extracted. The browser runs this on K's device and sends only the
// result; the server validates what it receives with the same rules.

export interface PastSale {
  orderId: string;
  itemId: string;
  title: string;
  quantity: number;
  /** "Sold for", GBP, per unit. */
  price: number;
  /** "Postage and packaging", GBP. */
  shipping: number | null;
  /** Sale date, YYYY-MM-DD. */
  date: string;
}

const COLUMNS = {
  orderId: "Order number",
  itemId: "Item number",
  title: "Item title",
  quantity: "Quantity",
  price: "Sold for",
  shipping: "Postage and packaging",
  date: "Sale date",
} as const;

/** RFC 4180-style CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') (field += '"'), i++;
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

const money = (s: string): number | null => {
  const m = String(s ?? "").replace(/[£,\s]/g, "").match(/^-?\d+(\.\d+)?$/);
  return m ? Math.round(Number(m[0]) * 100) / 100 : null;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "27-Sep-26" (eBay UK) or "Sep-27-26" (eBay US) to YYYY-MM-DD. */
export function reportDate(s: string): string | null {
  const parts = String(s ?? "").trim().split(/[-\s/]+/);
  if (parts.length !== 3) return null;
  let [a, b, y] = parts;
  if (MONTHS.includes(a.toLowerCase().slice(0, 3))) [a, b] = [b, a];
  const month = MONTHS.indexOf(b.toLowerCase().slice(0, 3)) + 1;
  const day = Number(a);
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  if (!month || !(day >= 1 && day <= 31) || !(year >= 2000 && year <= 2100)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Validates one sale with the rules the server also applies. */
export function cleanSale(s: any): PastSale | null {
  const orderId = String(s?.orderId ?? "").trim();
  const itemId = String(s?.itemId ?? "").trim();
  const title = String(s?.title ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  const quantity = Number(s?.quantity);
  const price = Number(s?.price);
  const shipping = s?.shipping == null ? null : Number(s.shipping);
  const date = String(s?.date ?? "");
  if (!/^[\d-]{6,30}$/.test(orderId) || !/^\d{6,20}$/.test(itemId) || !title) return null;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) return null;
  if (!(price > 0 && price < 100_000) || (shipping != null && !(shipping >= 0 && shipping < 10_000))) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { orderId, itemId, title, quantity, price, shipping, date };
}

/** Reads the report and returns only K's sales: the seven columns above, nothing about buyers. */
export function readSalesReport(text: string): { sales: PastSale[]; skipped: number } {
  const rows = parseCsv(text);
  const headerAt = rows.findIndex((r) => r.includes(COLUMNS.itemId) && r.includes(COLUMNS.price));
  if (headerAt < 0) throw new Error("This doesn't look like an eBay orders report: no Item number and Sold for columns.");
  const header = rows[headerAt];
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => [k, header.indexOf(name)])) as Record<keyof typeof COLUMNS, number>;
  const sales: PastSale[] = [];
  let skipped = 0;
  for (const r of rows.slice(headerAt + 1)) {
    if (r.length < header.length / 2 || r.every((f) => !f.trim())) continue; // blank and summary lines
    const sale = cleanSale({
      orderId: r[at.orderId],
      itemId: r[at.itemId],
      title: r[at.title],
      quantity: Number(r[at.quantity]),
      price: money(r[at.price]),
      shipping: at.shipping >= 0 ? money(r[at.shipping]) : null,
      date: reportDate(r[at.date]),
    });
    sale ? sales.push(sale) : skipped++;
  }
  return { sales, skipped };
}
