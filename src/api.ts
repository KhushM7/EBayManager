import type { Env } from "./env";
import { gateClosedReason, setWritesPaused, writesPaused } from "./ebay/write";
import { auditListing } from "./jobs";
import { runNightly } from "./nightly";
import { push } from "./notify";
import { CLAUDE_DAILY_BUDGET_USD } from "./rules";
import { pollInbox } from "./inbox";
import { applyApproved, decide, editProposal } from "./proposals";
import { saveSubscription, vapidPublicKey } from "./push";
import {
  addPasskeyOptions,
  clearCookie,
  completeAddPasskey,
  completeLogin,
  completeRegistration,
  createInvite,
  createSession,
  endSession,
  listPeople,
  loginOptions,
  recordFailure,
  registrationOptions,
  removePasskey,
  removePerson,
  signOutEverywhere,
  tooManyAttempts,
  useRecoveryCode,
  userCount,
} from "./auth/users";
import { checkKey, CSRF_HEADER, getSession, keyLogin } from "./session";
import { snapshotListings } from "./snapshot";
import { MONTHLY_CAP, providerEnabled, usedThisMonth, type Provider } from "./solddata";
import { evaluateProviders } from "./solddata-eval";
import { priceListing } from "./pricing/engine";
import { cleanSale } from "./salesreport";
import { latestReport, runFirstDayAudit } from "./firstday";
import { getAnsweredQuestions, getSentMessages } from "./ebay/history";
import { editStyle, getStyle, learnStyle, saveStyle } from "./style";
import { reviewPromotions } from "./promotion";

// JSON API for the dashboard. Everything except sign-in needs a signed-in person (docs/security.md); some
// actions are owner-only. Sign-in failures are rate-limited per network.

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

  // Same-origin only for anything that changes state (with the header above and SameSite=Strict cookies).
  const origin = request.headers.get("Origin");
  if (method !== "GET" && origin && origin !== new URL(env.PUBLIC_URL).origin && origin !== url.origin)
    return json({ error: "Wrong origin" }, 403);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limited = async () => tooManyAttempts(env, `ip:${ip}`, 20, 3_600_000);
  const fail = async (status: number, error: string) => (await recordFailure(env, `ip:${ip}`), json({ error }, status));
  const run = async (fn: () => Promise<Response>) => {
    try {
      return await fn();
    } catch (e) {
      return fail(400, e instanceof Error ? e.message : String(e));
    }
  };

  // --- Signing in (no session needed) ---
  if (path.startsWith("/auth/") || path === "/login" || path === "/setup") {
    if (await limited()) return json({ error: "Too many attempts. Wait an hour and try again." }, 429);
    const b = method === "POST" ? await body(request) : {};

    if (path === "/auth/login/options" && method === "POST") return json(await loginOptions(env));
    if (path === "/auth/login/verify" && method === "POST")
      return run(async () => {
        const userId = await completeLogin(env, b.challengeId, b.credential);
        return json({ ok: true }, 200, { "Set-Cookie": await createSession(env, userId, request) });
      });
    if (path === "/auth/recover" && method === "POST")
      return run(async () => {
        const userId = await useRecoveryCode(env, b.code);
        return json({ ok: true, mustAddPasskey: true }, 200, { "Set-Cookie": await createSession(env, userId, request, true) });
      });
    if (path === "/auth/register/options" && method === "POST") return run(async () => json(await registrationOptions(env, b.invite)));
    if (path === "/auth/register/verify" && method === "POST")
      return run(async () => {
        const r = await completeRegistration(env, b.challengeId, b.credential, String(b.label ?? ""));
        return json({ recoveryCodes: r.recoveryCodes }, 200, { "Set-Cookie": await createSession(env, r.userId, request) });
      });
    // The owner's first invite, while nobody is registered. Needs DASHBOARD_KEY.
    if (path === "/setup" && method === "POST") {
      if ((await userCount(env)) > 0) return json({ error: "Already set up" }, 403);
      if (!checkKey(env, b.key)) return fail(401, "Wrong key");
      const token = await createInvite(env, String(b.name ?? "K"), "owner", null);
      return json({ inviteUrl: `${env.PUBLIC_URL}/join#${token}` });
    }
    // Sandbox only.
    if (path === "/login" && method === "POST") {
      const cookie = await keyLogin(env, request, b.key);
      return cookie ? json({ ok: true }, 200, { "Set-Cookie": cookie }) : fail(401, "Wrong key");
    }
    return json({ error: "Not found" }, 404);
  }

  if (path === "/logout" && method === "POST") {
    await endSession(env, request);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie });
  }

  const session = await getSession(env, request);
  if (!session) return json({ error: "Sign in" }, 401);
  const { user } = session;
  const owner = user.role === "owner";
  const ownerOnly = () => json({ error: "Only the owner can do that" }, 403);

  // After a recovery code, the only thing allowed is registering a new passkey.
  if (session.mustAddPasskey && !["/me", "/passkeys/options", "/passkeys/verify"].includes(path))
    return json({ error: "Register a new passkey first", mustAddPasskey: true }, 403);

  if (path === "/passkeys/options" && method === "POST") return json(await addPasskeyOptions(env, user));
  if (path === "/passkeys/verify" && method === "POST") {
    const b = await body(request);
    return run(async () => json(await completeAddPasskey(env, user, b.challengeId, b.credential, String(b.label ?? ""), session.id)));
  }
  const removeKey = path.match(/^\/passkeys\/([\w-]+)\/remove$/);
  if (removeKey && method === "POST") return run(async () => (await removePasskey(env, user, removeKey[1]), json({ ok: true })));

  if (path === "/people" && method === "GET") return owner ? json(await listPeople(env)) : ownerOnly();
  if (path === "/people/invite" && method === "POST") {
    if (!owner) return ownerOnly();
    const b = await body(request);
    return run(async () => json({ inviteUrl: `${env.PUBLIC_URL}/join#${await createInvite(env, String(b.name ?? ""), "manager", user.id)}` }));
  }
  const person = path.match(/^\/people\/([\w-]+)\/(remove|signout)$/);
  if (person && method === "POST") {
    if (!owner && person[1] !== user.id) return ownerOnly();
    return run(async () => {
      if (person[2] === "remove") {
        if (!owner) throw new Error("Only the owner can remove people");
        await removePerson(env, user, person[1]);
      } else await signOutEverywhere(env, person[1]);
      return json({ ok: true });
    });
  }

  if (path === "/me" && method === "GET") {
    const lastPush = await setting(env, "last_push_at");
    const connected = await env.DB.prepare("SELECT scopes FROM ebay_tokens WHERE id = 1").first<{ scopes: string }>();
    return json({
      user,
      mustAddPasskey: session.mustAddPasskey,
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
    for (const id of ids.slice(0, 100)) results.push({ id: String(id), result: await decide(env, String(id), decision, user.name) });
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

  // K's floor and facts for one listing. Facts are used by listing edits and reply drafts, cited "from K".
  const itemSettings = path.match(/^\/items\/(\d{6,20})\/settings$/);
  if (itemSettings && method === "POST") {
    if (!owner) return ownerOnly();
    const b = await body(request);
    const floor = b.floorPrice === null || b.floorPrice === "" ? null : Number(b.floorPrice);
    if (floor != null && !(floor > 0 && floor < 100_000)) return json({ error: "Floor must be a price in pounds" }, 400);
    const notes = typeof b.notes === "string" ? b.notes.trim().slice(0, 2000) || null : null;
    await env.DB.prepare(
      `INSERT INTO item_settings (item_id, floor_price, notes) VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET floor_price = excluded.floor_price, notes = excluded.notes`,
    )
      .bind(itemSettings[1], floor, notes)
      .run();
    return json({ ok: true, floorPrice: floor, notes });
  }
  if (itemSettings && method === "GET")
    return json(
      (await env.DB.prepare("SELECT floor_price AS floorPrice, notes FROM item_settings WHERE item_id = ?").bind(itemSettings[1]).first()) ?? {
        floorPrice: null,
        notes: null,
      },
    );

  if (path === "/activity" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.at, a.env, a.proposal_id, a.call, a.outcome, a.actor, substr(a.response, 1, 300) AS response, p.kind, p.item_id
       FROM audit_log a LEFT JOIN proposals p ON p.id = a.proposal_id ORDER BY a.id DESC LIMIT 200`,
    ).all();
    return json(results);
  }

  if (path === "/settings/writes" && method === "POST") {
    const { paused } = await body(request);
    // Anyone can pause; only the owner can resume.
    if (!paused && !owner) return ownerOnly();
    await setWritesPaused(env, Boolean(paused));
    // Resuming applies what K approved while paused.
    const applied = paused ? [] : await applyApproved(env);
    return json({ writesPaused: Boolean(paused), applied });
  }

  const edit = path.match(/^\/proposals\/([\w-]+)\/edit$/);
  if (edit && method === "POST") {
    const result = await editProposal(env, edit[1], await body(request), user.name);
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

  // The pricing engine on one listing (docs/pricing-engine.md). Read-only on eBay; spends sold-data
  // searches and a few Haiku calls, so owner only.
  if (path === "/pricing/check" && method === "POST") {
    if (!owner) return ownerOnly();
    const { itemId } = await body(request);
    if (typeof itemId !== "string" || !/^\d{6,20}$/.test(itemId)) return json({ error: "Bad item id" }, 400);
    return run(async () => json(await priceListing(env, itemId)));
  }

  if (path === "/pricing/latest" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT item_id, at, strategy, price, total, predicted_days, result FROM price_decisions d
       WHERE at = (SELECT MAX(at) FROM price_decisions x WHERE x.item_id = d.item_id) AND item_id IS NOT NULL`,
    ).all<any>();
    return json(results.map((r) => ({ ...r, result: JSON.parse(r.result) })));
  }

  if (path === "/pricing/advice" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT id, at, detail FROM bundle_advice WHERE status = 'open' ORDER BY id").all<any>();
    return json(results.map((r) => ({ id: r.id, at: r.at, ...JSON.parse(r.detail) })));
  }

  if (path === "/pricing/advice/dismiss" && method === "POST") {
    const { id } = await body(request);
    if (!Number.isInteger(id)) return json({ error: "Bad id" }, 400);
    await env.DB.prepare("UPDATE bundle_advice SET status = 'dismissed' WHERE id = ? AND status = 'open'").bind(id).run();
    return json({ ok: true });
  }

  // The first-day audit (docs/listing-assistant.md). Reading the report is open to all three; running it
  // spends sold-data searches and a Claude call, so owner only. Read-only on eBay either way.
  if (path === "/firstday" && method === "GET") return json({ report: await latestReport(env) });
  if (path === "/firstday/run" && method === "POST") {
    if (!owner) return ownerOnly();
    const b = await body(request);
    return run(async () => json({ report: await runFirstDayAudit(env, { relearnStyle: b.relearnStyle === true }) }));
  }

  // K's reply style guide: everyone can read it; only K edits or relearns it (it's K's voice).
  if (path === "/style" && method === "GET") return json({ style: await getStyle(env) });
  if (path === "/style" && method === "POST") {
    if (!owner) return ownerOnly();
    const b = await body(request);
    if (typeof b.style !== "object" || !b.style) return json({ error: "Send the guide" }, 400);
    return run(async () => json({ style: await editStyle(env, b.style, user.name) }));
  }
  if (path === "/style/learn" && method === "POST") {
    if (!owner) return ownerOnly();
    return run(async () => {
      const replies = [...(await getAnsweredQuestions(env)), ...(await getSentMessages(env).catch(() => []))];
      const style = await learnStyle(env, replies);
      await saveStyle(env, style);
      return json({ style });
    });
  }

  // Promotion research on listings with a recent market picture (normally nightly).
  if (path === "/promotion/review" && method === "POST") {
    if (!owner) return ownerOnly();
    return run(async () => json({ result: await reviewPromotions(env) }));
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

  if (path === "/solddata" && method === "GET") {
    const providers = await Promise.all(
      (["trawl", "compsapi"] as Provider[]).map(async (p) => ({ provider: p, enabled: providerEnabled(env, p), used: await usedThisMonth(env, p), cap: MONTHLY_CAP[p] })),
    );
    const last = await setting(env, "solddata_eval");
    return json({ providers, primary: await setting(env, "solddata_primary"), lastEval: last ? JSON.parse(last) : null });
  }

  // Past sales from Seller Hub's orders report (eBay's APIs only return 90 days). The browser has already
  // dropped every buyer column; the server re-validates each sale and stores only the sales fields.
  if (path === "/sales/import" && method === "POST") {
    if (!owner) return ownerOnly();
    const { sales } = await body(request);
    if (!Array.isArray(sales) || sales.length > 5000) return json({ error: "Send at most 5,000 sales" }, 400);
    const clean = sales.map(cleanSale).filter((s): s is NonNullable<ReturnType<typeof cleanSale>> => s !== null);
    let imported = 0;
    for (let i = 0; i < clean.length; i += 50) {
      const batch = clean.slice(i, i + 50).flatMap((s) => [
        env.DB.prepare(
          "INSERT OR IGNORE INTO orders (order_id, created_at, total, fees, currency, status) VALUES (?, ?, ?, NULL, 'GBP', 'IMPORTED')",
        ).bind(s.orderId, Date.parse(`${s.date}T12:00:00Z`), Math.round((s.price * s.quantity + (s.shipping ?? 0)) * 100) / 100),
        env.DB.prepare("INSERT OR IGNORE INTO order_items (order_id, item_id, title, quantity, price) VALUES (?, ?, ?, ?, ?)").bind(
          s.orderId,
          s.itemId,
          s.title,
          s.quantity,
          Math.round(s.price * s.quantity * 100) / 100,
        ),
      ]);
      const res = await env.DB.batch(batch);
      imported += res.filter((_, j) => j % 2 === 1).reduce((n, r: any) => n + (r.meta?.changes ?? 0), 0);
    }
    return json({ received: sales.length, valid: clean.length, imported, alreadyThere: clean.length - imported });
  }

  // Spends up to 5 searches per provider, so owner only.
  if (path === "/solddata/evaluate" && method === "POST") {
    if (!owner) return ownerOnly();
    return run(async () => json(await evaluateProviders(env)));
  }

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
