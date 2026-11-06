import { describe, expect, it } from "vitest";
import { memoryStore, orderLines } from "../src/store";
import type { Env } from "../src/env";
import { handleApi } from "../src/api";
import { readSalesReport, reportDate } from "../src/salesreport";

// A made-up report in eBay UK's layout: a blank first line, the header, a blank row, sales, then summary lines.
const header =
  '"Sales record number","Order number","Buyer username","Buyer name","Buyer email","Buyer note",Buyer address 1,Buyer address 2,Buyer city,"Buyer county","Buyer postcode","Buyer country",Post to name,"Post to phone","Item number","Item title",Custom label,"Quantity","Sold for","Postage and packaging","Total price","Sale date","My item note"';
const row = (order: string, item: string, title: string, sold: string, post: string, date: string) =>
  `"1","${order}","jane_doe_77","Jane Doe","jane@example.com","Please leave by the door","1 High Street","","Leeds","","LS1 1AA","United Kingdom","Jane Doe","07700 900000","${item}","${title.replace(/"/g, '""')}","","1","${sold}","${post}","£0","${date}","note with a\nnewline"`;
const CSV = [
  "",
  header,
  ",,,,,,,,,,,,,,,,,,,,,,",
  row("05-15231-36508", "178305344332", "Nerf Mega Centurion, Boxed", "£32.97", "£4.34", "27-Sep-26"),
  row("09-12791-50228", "176887824593", 'Case "Black" for S24', "£1,018.50", "£0.00", "05-Mar-25"),
  row("bad", "x", "Broken row", "free", "", "someday"),
  "",
  '"2","record(s) downloaded",""',
  '"Seller ID : someone"',
].join("\n");

describe("Seller Hub orders report", () => {
  it("keeps only the seven sales columns and nothing about buyers", () => {
    const { sales, skipped } = readSalesReport(CSV);
    expect(skipped).toBe(1);
    expect(sales).toEqual([
      { orderId: "05-15231-36508", itemId: "178305344332", title: "Nerf Mega Centurion, Boxed", quantity: 1, price: 32.97, shipping: 4.34, date: "2026-09-27" },
      { orderId: "09-12791-50228", itemId: "176887824593", title: 'Case "Black" for S24', quantity: 1, price: 1018.5, shipping: 0, date: "2025-03-05" },
    ]);
    const out = JSON.stringify(sales);
    for (const personal of ["jane", "Jane", "Doe", "High Street", "LS1", "07700", "door", "newline"]) expect(out).not.toContain(personal);
  });

  it("reads eBay's UK and US date styles", () => {
    expect(reportDate("27-Sep-26")).toBe("2026-09-27");
    expect(reportDate("Sep-27-26")).toBe("2026-09-27");
    expect(reportDate("31-Foo-26")).toBeNull();
  });

  it("refuses a file that isn't an orders report", () => {
    expect(() => readSalesReport("a,b,c\n1,2,3")).toThrow(/orders report/);
  });
});

describe("importing past sales", () => {
  const ORIGIN = "https://app.example";
  const env = () => ({ store: memoryStore(), EBAY_ENV: "sandbox", PUBLIC_URL: ORIGIN, DASHBOARD_KEY: "k-123", ALLOW_KEY_LOGIN: "true" }) as Env;
  const call = async (e: Env, path: string, body: unknown, cookie = "") => {
    const url = new URL(`${ORIGIN}/api${path}`);
    const res = await handleApi(e, new Request(url, { method: "POST", headers: { "X-EbayManager": "1", Cookie: cookie }, body: JSON.stringify(body) }), url);
    return { status: res.status, json: (await res.json()) as any, cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] };
  };

  it("stores only validated sales fields, owner only, without duplicating on a second import", async () => {
    const e = env();
    const owner = (await call(e, "/login", { key: "k-123" })).cookie;
    const { sales } = readSalesReport(CSV);
    const withExtras = [...sales.map((s) => ({ ...s, buyerEmail: "jane@example.com" })), { orderId: "x", itemId: "1", title: "bad" }];

    const first = await call(e, "/sales/import", { sales: withExtras }, owner);
    expect(first.json).toEqual({ received: 3, valid: 2, imported: 2, alreadyThere: 0 });
    expect((await call(e, "/sales/import", { sales }, owner)).json.imported).toBe(0);

    const orders = await e.store.orders.all();
    const lines = orderLines(orders).sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    expect(lines.map((r) => [r.item_id, r.price])).toEqual([
      ["178305344332", 32.97],
      ["176887824593", 1018.5],
    ]);
    const all = JSON.stringify(await e.store.docs.query("orders", {}));
    expect(all).not.toContain("jane");

    expect((await call(e, "/sales/import", { sales })).status).toBe(401);
  });
});
