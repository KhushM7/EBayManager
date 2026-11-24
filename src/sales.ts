import type { Env } from "./env";
import { getSoldLines, newDiag, type CallDiag } from "./ebay/inbox";
import { getRecentOrders } from "./ebay/sell";
import { log, swallow } from "./log";
import { push } from "./notify";
import { snapshotListings } from "./snapshot";

// Sales, as they happen (the nightly sync stays as the backstop). Paid orders come from eBay's Fulfillment API; a
// purchase nobody has paid for yet only from My eBay's sold list. No buyer field is read, kept or logged.

const DAY = 86_400_000;
const money = (n: number | null | undefined) => (n == null ? "" : `£${n.toFixed(2)}`);

type Call = <T>(what: string, d: CallDiag, fn: () => Promise<T[]>) => Promise<T[] | null>;

const DONE = /^(FULFILLED|CANCEL)/i;

/**
 * Reads the last days' orders and sold lines, tells K once about each new one, and keeps a to-do open until it's
 * dispatched or paid. Orders that existed at the first run are kept without a word.
 */
export async function syncSales(env: Env, call: Call, now: number): Promise<{ sales: number; errors: string[] }> {
  const errors: string[] = [];
  const saved = await env.store.kv.getJson<{ at: number }>("sales_since");
  const since = saved?.at ?? now;

  let sales = 0;
  const od = newDiag("getOrders");
  const orders = await call("orders", od, async () => {
    const t = Date.now();
    try {
      const got = await getRecentOrders(env, 3);
      od.ack = "Success";
      od.pages = 1;
      od.returned = od.kept = got.length;
      for (const o of got) od.statuses[o.status ?? "none"] = (od.statuses[o.status ?? "none"] ?? 0) + 1;
      return got;
    } catch (e) {
      od.failed = e instanceof Error ? e.message.slice(0, 300) : String(e);
      throw e;
    } finally {
      od.ms = Date.now() - t;
    }
  });
  if (orders) {
    await env.store.orders.upsertFromApi(orders);
    for (const o of orders) {
      if (o.createdAt <= since || !(await env.store.orders.announce(o.orderId, now))) continue;
      sales++;
      const titles = o.items.map((i) => i.title).join(", ").slice(0, 120);
      await log(env, "info", "sale.new", { itemId: o.items[0]?.itemId, detail: `${o.items.length} item(s), status ${o.status}` });
      await push(env, o.items.length > 1 ? `Sold ${o.items.length} items together` : "Sold", `${titles} ${o.items.map((i) => money(i.price)).join(" + ")}`, undefined, `sale-${o.orderId}`).catch(swallow(env, "sale.push_failed"));
    }
  }

  const sd = newDiag("GetMyeBaySelling:SoldList");
  const lines = await call("sold list", sd, () => getSoldLines(env, sd));
  if (lines) {
    // A paid order for the same listing made since the purchase settles it, whatever the sold list says.
    const paid = (await env.store.orders.since(now - 15 * DAY)).flatMap((o) => Object.keys(o.items ?? {}).map((id) => ({ id, at: o.created_at })));
    const settled = (itemId: string, at: number) => paid.some((p) => p.id === itemId && p.at >= at - DAY);
    const seen = new Set<string>();
    for (const l of lines) {
      const at = l.createdAt ?? now;
      const state = l.paid || settled(l.itemId, at) ? "paid" : "unpaid";
      seen.add(l.lineId);
      // Paid lines are orders already; only one seen unpaid is followed here.
      const known = (await env.store.orders.commitments()).some((c) => c.line_id === l.lineId);
      if (state === "paid" && !known) continue;
      const isNew = await env.store.orders.saveCommitment({ line_id: l.lineId, item_id: l.itemId, title: l.title, quantity: l.quantity, price: l.price, created_at: at, state }, now);
      if (!isNew || (saved == null) || at <= since) continue;
      sales++;
      await log(env, "info", "sale.awaiting_payment", { itemId: l.itemId, detail: `price ${l.price}` });
      await push(env, "Bought, not paid yet", `${l.title.slice(0, 100)} ${money(l.price)}. Check it on eBay if it needs you to accept it.`, undefined, `commit-${l.lineId}`).catch(swallow(env, "sale.push_failed"));
    }
    for (const c of await env.store.orders.commitments())
      if (c.state === "unpaid" && (!seen.has(c.line_id) || settled(c.item_id, c.created_at)))
        await env.store.orders.saveCommitment({ line_id: c.line_id, item_id: c.item_id, title: c.title, quantity: c.quantity, price: c.price, created_at: c.created_at, state: settled(c.item_id, c.created_at) ? "paid" : "gone" }, now);
  }
  if (!saved) await env.store.kv.setJson("sales_since", { at: now });

  // To-dos, filed by what's true now: an order to post, a purchase waiting for payment. Resolved as that changes.
  try {
    const recent = (await env.store.orders.since(now - 30 * DAY)).filter((o) => (o as any).announced_at && o.status && !DONE.test(o.status) && o.status !== "IMPORTED");
    if (orders)
      await env.store.todos.sync(
        "sales",
        { codes: ["dispatch"] },
        recent.map((o) => {
          const items = Object.values(o.items ?? {});
          return {
            code: "dispatch",
            kind: "you" as const,
            itemId: null,
            itemTitle: items.map((i) => i.title).join(", ").slice(0, 120),
            subject: o.order_id,
            title: "Sold: post it",
            detail: `${items.map((i) => `${i.title}${i.price != null ? `, ${money(i.price)}` : ""}`).join("\n")}\nThe postage label and the buyer's address are in eBay. This closes when eBay shows it as dispatched.`,
            fingerprint: o.order_id,
          };
        }),
        now,
      );
    if (lines)
      await env.store.todos.sync(
        "sales",
        { codes: ["awaiting_payment"] },
        (await env.store.orders.commitments())
          .filter((c) => c.state === "unpaid" && c.first_seen > since)
          .map((c) => ({
            code: "awaiting_payment",
            kind: "you" as const,
            itemId: null,
            itemTitle: c.title,
            subject: c.line_id,
            title: "Bought, not paid yet",
            detail: `${c.title}${c.price != null ? `, ${money(c.price)}` : ""}. Don't post it until it's paid. If eBay asks you to accept it, do that on eBay.`,
            fingerprint: c.line_id,
          })),
        now,
      );
  } catch (err) {
    errors.push(`sales to-dos: ${err instanceof Error ? err.message : String(err)}`);
    await log(env, "error", "sale.todo_failed", { err });
  }
  if (sales) await snapshotListings(env).catch(swallow(env, "sale.snapshot_failed"));
  return { sales, errors };
}

export interface SaleRow {
  id: string;
  at: number;
  title: string;
  price: number | null;
  itemIds: string[];
  state: "paid" | "dispatched" | "unpaid" | "cancelled" | "imported";
}

/** Sales for the app, newest first, with no buyer. */
export async function listSales(env: Env, now = Date.now(), days = 90): Promise<SaleRow[]> {
  const orders = (await env.store.orders.since(now - days * DAY)).map((o): SaleRow => {
    const items = Object.entries(o.items ?? {});
    const priced = items.map(([, i]) => i.price).filter((p): p is number => p != null);
    const s = o.status ?? "";
    return {
      id: o.order_id,
      at: o.created_at,
      title: items.map(([, i]) => i.title).join(", "),
      price: priced.length ? Math.round(priced.reduce((a, b) => a + b, 0) * 100) / 100 : null,
      itemIds: items.map(([id]) => id),
      state: s === "IMPORTED" ? "imported" : /^CANCEL/i.test(s) ? "cancelled" : s === "FULFILLED" ? "dispatched" : "paid",
    };
  });
  const waiting = (await env.store.orders.commitments())
    .filter((c) => c.state === "unpaid")
    .map((c): SaleRow => ({ id: c.line_id, at: c.created_at, title: c.title, price: c.price, itemIds: [c.item_id], state: "unpaid" }));
  return [...waiting, ...orders].sort((a, b) => b.at - a.at);
}
