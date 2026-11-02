import type { Env } from "./env";
import { gateClosedReason, setWritesPaused, writesPaused } from "./ebay/write";
import { auditListing } from "./jobs";
import { runNightly } from "./nightly";
import { push } from "./notify";
import { CLAUDE_DAILY_BUDGET_USD } from "./rules";
import { pollInbox } from "./inbox";
import { applyApproved, decide, editProposal } from "./proposals";
import { saveSubscription, vapidPublicKey } from "./push";
import { checkKey, clearCookie, CSRF_HEADER, hasSession, sessionCookie } from "./session";
import { snapshotListings } from "./tools";

// JSON API for the dashboard. Everything except sign-in needs K's session cookie.

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });

async function body(request: Request): Promise<any> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const setting = async (env: Env, key: string) =>
  (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;

export async function handleApi(env: Env, request: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  if (method !== "GET" && request.headers.get(CSRF_HEADER) !== "1") return json({ error: "Missing request header" }, 403);

  if (path === "/login" && method === "POST") {
    const { key } = await body(request);
    if (!checkKey(env, key)) return json({ error: "Wrong key" }, 401);
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env) });
  }
  if (path === "/logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearCookie });

  if (!(await hasSession(env, request))) return json({ error: "Sign in" }, 401);

  if (path === "/me" && method === "GET") {
    const lastPush = await setting(env, "last_push_at");
    const connected = await env.DB.prepare("SELECT scopes FROM ebay_tokens WHERE id = 1").first<{ scopes: string }>();
    return json({
      ebayEnv: env.EBAY_ENV,
      writeMode: env.WRITE_MODE,
      writesPaused: await writesPaused(env),
      writesBlocked: await gateClosedReason(env),
      ebayConnected: Boolean(connected),
      ebayScopes: connected ? (/sell\.inventory\.readonly/.test(connected.scopes) ? "read-only" : "full") : null,
      vapidPublicKey: vapidPublicKey(env),
      lastPushAt: lastPush ? Number(lastPush) : null,
    });
  }

  if (path === "/proposals" && method === "GET") {
    const status = url.searchParams.get("status") ?? "pending";
    const { results } = await env.DB.prepare(
      `SELECT p.*, (SELECT title FROM listing_snapshots s WHERE s.item_id = p.item_id ORDER BY taken_at DESC LIMIT 1) AS item_title,
              (SELECT price FROM listing_snapshots s WHERE s.item_id = p.item_id ORDER BY taken_at DESC LIMIT 1) AS item_price
       FROM proposals p WHERE p.status = ? ORDER BY p.created_at DESC LIMIT 200`,
    )
      .bind(status)
      .all<any>();
    return json(results.map((p) => ({ ...p, payload: JSON.parse(p.payload) })));
  }

  if (path === "/proposals/decide" && method === "POST") {
    const { ids, decision } = await body(request);
    if (!Array.isArray(ids) || (decision !== "approve" && decision !== "reject")) return json({ error: "Bad request" }, 400);
    // One at a time, each applied and logged on its own, so one failure doesn't block the rest.
    const results: { id: string; result: string }[] = [];
    for (const id of ids.slice(0, 100)) results.push({ id: String(id), result: await decide(env, String(id), decision) });
    return json({ results });
  }

  if (path === "/listings" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT s.item_id, s.title, s.price, s.currency, s.watch_count, s.view_count, s.quantity_available, s.start_time, s.taken_at,
              i.floor_price, i.collection_only, i.notes,
              (SELECT COUNT(*) FROM proposals p WHERE p.item_id = s.item_id AND p.status = 'pending') AS pending
       FROM listing_snapshots s LEFT JOIN item_settings i ON i.item_id = s.item_id
       WHERE s.taken_at = (SELECT MAX(taken_at) FROM listing_snapshots)
       ORDER BY s.start_time`,
    ).all();
    return json(results);
  }

  if (path === "/listings/refresh" && method === "POST") return json(await snapshotListings(env));

  if (path === "/activity" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.at, a.env, a.proposal_id, a.call, a.outcome, substr(a.response, 1, 300) AS response, p.kind, p.item_id
       FROM audit_log a LEFT JOIN proposals p ON p.id = a.proposal_id ORDER BY a.id DESC LIMIT 200`,
    ).all();
    return json(results);
  }

  if (path === "/settings/writes" && method === "POST") {
    const { paused } = await body(request);
    await setWritesPaused(env, Boolean(paused));
    // Resuming applies what K approved while paused.
    const applied = paused ? [] : await applyApproved(env);
    return json({ writesPaused: Boolean(paused), applied });
  }

  const edit = path.match(/^\/proposals\/([\w-]+)\/edit$/);
  if (edit && method === "POST") {
    const result = await editProposal(env, edit[1], await body(request));
    return json({ result }, result === "Saved" ? 200 : 400);
  }

  if (path === "/inbox/poll" && method === "POST") return json(await pollInbox(env));

  if (path === "/push/subscribe" && method === "POST") {
    const { subscription } = await body(request);
    const s = subscription ?? {};
    if (typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || !s.keys?.p256dh || !s.keys?.auth)
      return json({ error: "Bad subscription" }, 400);
    await saveSubscription(env, { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth }, request.headers.get("User-Agent") ?? "");
    return json({ ok: true });
  }

  if (path === "/push/unsubscribe" && method === "POST") {
    const { endpoint } = await body(request);
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(String(endpoint)).run();
    return json({ ok: true });
  }

  if (path === "/push/devices" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT endpoint, user_agent, created_at, last_ok_at, last_error FROM push_subscriptions ORDER BY created_at DESC",
    ).all();
    return json(results);
  }

  if (path === "/push/test" && method === "POST") {
    await push(env, "Test notification", "Notifications from EBayManager reach this device.", undefined, "test");
    return json({ ok: true, lastPushAt: Number(await setting(env, "last_push_at")) || null });
  }

  if (path === "/audit" && method === "POST") {
    const { itemId } = await body(request);
    if (typeof itemId !== "string" || !/^\d{6,20}$/.test(itemId)) return json({ error: "Bad item id" }, 400);
    try {
      const r = await auditListing(env, itemId);
      return json({ itemId, note: r.text, turns: r.turns, costUsd: r.costUsd, stopReason: r.stopReason });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 503);
    }
  }

  if (path === "/usage" && method === "GET") {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const month = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
    const sum = (since: number) =>
      env.DB.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls FROM claude_usage WHERE at >= ?")
        .bind(since)
        .first<{ usd: number; calls: number }>();
    const { results: byJob } = await env.DB.prepare(
      `SELECT CASE WHEN instr(job, ':') > 0 THEN substr(job, 1, instr(job, ':') - 1) ELSE job END AS job,
              COUNT(*) AS calls, SUM(cost_usd) AS usd
       FROM claude_usage WHERE at >= ? GROUP BY 1 ORDER BY usd DESC`,
    )
      .bind(month.getTime())
      .all();
    return json({
      today: await sum(day.getTime()),
      month: await sum(month.getTime()),
      byJob,
      dailyBudgetUsd: CLAUDE_DAILY_BUDGET_USD,
      apiKeySet: Boolean(env.ANTHROPIC_API_KEY),
    });
  }

  if (path === "/nightly" && method === "POST") return json(await runNightly(env));

  if (path === "/metrics" && method === "GET") return json(await metrics(env));

  return json({ error: "Not found" }, 404);
}

const DAY = 86_400_000;

/** Everything the Metrics screen draws, from D1 only (no eBay or Claude calls). */
export async function metrics(env: Env) {
  const since = Date.now() - 90 * DAY;
  const since30 = Date.now() - 30 * DAY;
  const all = async <T>(sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<T>()).results;

  // The last snapshot of each day.
  const listings = await all<{ day: string; active: number; asking: number; watchers: number }>(
    `SELECT date(s.taken_at / 1000, 'unixepoch') AS day, COUNT(*) AS active, SUM(s.price * MAX(s.quantity_available, 1)) AS asking,
            SUM(s.watch_count) AS watchers
     FROM listing_snapshots s
     WHERE s.taken_at >= ? AND s.taken_at = (SELECT MAX(taken_at) FROM listing_snapshots x WHERE date(x.taken_at / 1000, 'unixepoch') = date(s.taken_at / 1000, 'unixepoch'))
     GROUP BY day ORDER BY day`,
    since,
  );
  const sales = await all<{ day: string; orders: number; revenue: number; fees: number }>(
    `SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS orders, SUM(total) AS revenue, SUM(fees) AS fees
     FROM orders WHERE created_at >= ? GROUP BY day ORDER BY day`,
    since,
  );
  const spend = await all<{ day: string; usd: number; calls: number }>(
    `SELECT date(at / 1000, 'unixepoch') AS day, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM claude_usage WHERE at >= ? GROUP BY day ORDER BY day`,
    since,
  );
  const sold30 = await env.DB.prepare(
    `SELECT COUNT(DISTINCT i.item_id) AS items, COALESCE(SUM(o.total), 0) AS revenue, COALESCE(SUM(o.fees), 0) AS fees
     FROM orders o JOIN order_items i ON i.order_id = o.order_id WHERE o.created_at >= ?`,
  )
    .bind(since30)
    .first<{ items: number; revenue: number; fees: number }>();
  // Days from a listing's start to its sale, for items sold in the last 30 days that were snapshotted.
  const daysToSell = await env.DB.prepare(
    `SELECT AVG((o.created_at - st.ms) / 86400000.0) AS days
     FROM orders o JOIN order_items i ON i.order_id = o.order_id
     JOIN (SELECT item_id, (julianday(MIN(start_time)) - 2440587.5) * 86400000 AS ms FROM listing_snapshots GROUP BY item_id) st
       ON st.item_id = i.item_id
     WHERE o.created_at >= ?`,
  )
    .bind(since30)
    .first<{ days: number | null }>();
  const proposals = await all<{ status: string; n: number }>(
    "SELECT status, COUNT(*) AS n FROM proposals WHERE created_at >= ? GROUP BY status",
    since30,
  );
  const decideTimes = await all<{ mins: number }>(
    "SELECT (decided_at - created_at) / 60000.0 AS mins FROM proposals WHERE decided_at IS NOT NULL AND status IN ('applied', 'approved', 'rejected', 'failed') AND created_at >= ? ORDER BY mins",
    since30,
  );
  const flags = await all<{ item_id: string; flag: string; detail: string; title: string | null }>(
    `SELECT f.item_id, f.flag, f.detail, (SELECT title FROM listing_snapshots s WHERE s.item_id = f.item_id ORDER BY taken_at DESC LIMIT 1) AS title
     FROM health_flags f WHERE f.checked_at = (SELECT MAX(checked_at) FROM health_flags)`,
  );
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_nightly'").first<{ value: string }>();
  const active = listings.at(-1)?.active ?? 0;
  return {
    listings,
    sales,
    spend,
    sold30: { ...sold30, sellThrough: sold30 && sold30.items + active > 0 ? sold30.items / (sold30.items + active) : null },
    avgDaysToSell: daysToSell?.days ?? null,
    proposals: Object.fromEntries(proposals.map((p) => [p.status, p.n])),
    medianMinutesToDecide: decideTimes.length ? decideTimes[Math.floor(decideTimes.length / 2)].mins : null,
    flags,
    lastNightly: last ? JSON.parse(last.value) : null,
  };
}
