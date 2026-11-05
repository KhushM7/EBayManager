import type { Env } from "./env";
import { gateClosedReason, setWritesPaused, writesPaused } from "./ebay/write";
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
import { cleanSale } from "./salesreport";
import { orderLines } from "./store";
import { jobStatus, startJob } from "./background";
import { latestReport } from "./firstday";
import { fileAuditTodos, parsePrice } from "./todos";
import { priceListing } from "./pricing/engine";
import { tools } from "./tools";
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

/**
 * The caller's address, for rate limits. On Azure Functions (Flex Consumption) the front end overwrites
 * Client-IP with the connecting address as "ip:port"; X-Client-IP, X-Real-IP, X-Azure-ClientIP and the rest
 * pass through whatever a visitor sends (tested on Sandbox, 2026-11-04: docs/azure-migration.md, question 4).
 * So only Client-IP is read, its port removed; anything else counts as "unknown".
 */
export function clientIp(request: Request): string {
  let ip = (request.headers.get("Client-IP") ?? "").trim();
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::\d+)?$/.exec(ip); // [IPv6]:port
  if (bracketed) ip = bracketed[1];
  else if (/^[0-9.]+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":")); // IPv4:port
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : "unknown";
}

const setting = async (env: Env, key: string) =>
  env.store.kv.get(key);

export async function handleApi(env: Env, request: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  if (method !== "GET" && request.headers.get(CSRF_HEADER) !== "1") return json({ error: "Missing request header" }, 403);

  // Same-origin only for anything that changes state (with the header above and SameSite=Strict cookies).
  const origin = request.headers.get("Origin");
  if (method !== "GET" && origin && origin !== new URL(env.PUBLIC_URL).origin && origin !== url.origin)
    return json({ error: "Wrong origin" }, 403);

  const ip = clientIp(request);
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
    const connected = await env.store.kv.getEbayTokens();
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
    const rows = await env.store.proposals.listByStatus(status, "desc", 200);
    const latest = await env.store.listings.latestAll();
    return json(
      rows.map((p) => {
        const l = p.item_id ? latest.get(p.item_id) : undefined;
        const seen = l && l.taken_at ? l : undefined;
        return { ...p, item_title: seen?.title ?? null, item_price: seen?.price ?? null, payload: JSON.parse(p.payload) };
      }),
    );
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
    const settings = await env.store.listings.settingsAll();
    const pending = await env.store.proposals.listByStatus("pending", "asc");
    return json(
      (await env.store.listings.latestSet()).map((s) => {
        const i = settings.get(s.item_id);
        return {
          item_id: s.item_id,
          title: s.title,
          price: s.price,
          currency: s.currency,
          watch_count: s.watch_count,
          view_count: s.view_count ?? null,
          quantity_available: s.quantity_available,
          start_time: s.start_time,
          taken_at: s.taken_at,
          floor_price: i?.floor_price ?? null,
          collection_only: i ? i.collection_only : null,
          notes: i?.notes ?? null,
          pending: pending.filter((p) => p.item_id === s.item_id).length,
        };
      }),
    );
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
    await env.store.listings.setFloorAndNotes(itemSettings[1], floor, notes);
    // K's own price is only cleared here (it's set from the Inbox, when nothing comparable has sold).
    if (b.clearOwnPrice === true) await env.store.listings.setOwnPrice(itemSettings[1], null);
    return json({ ok: true, floorPrice: floor, notes });
  }
  if (itemSettings && method === "GET")
  {
    const s = await env.store.listings.getSettings(itemSettings[1]);
    return json(s ? { floorPrice: s.floor_price, notes: s.notes, ownPrice: s.own_price } : { floorPrice: null, notes: null, ownPrice: null });
  }

  if (path === "/activity" && method === "GET") {
    const rows = await env.store.audit.recent(200);
    return json(
      rows.map((a) => ({
        id: a.id,
        at: a.at,
        env: a.env,
        proposal_id: a.proposal_id,
        call: a.call,
        outcome: a.outcome,
        actor: a.actor,
        response: a.response == null ? null : String(a.response).slice(0, 300),
        kind: a.kind,
        item_id: a.item_id,
      })),
    );
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
    await env.store.push.delete(String(endpoint));
    return json({ ok: true });
  }

  if (path === "/push/devices" && method === "GET") {
    return json(
      (await env.store.push.list()).map((d) => ({ endpoint: d.endpoint, user_agent: d.user_agent, created_at: d.created_at, last_ok_at: d.last_ok_at, last_error: d.last_error })),
    );
  }

  if (path === "/push/test" && method === "POST") {
    await push(env, "Test notification", "Notifications from EBayManager reach this device.", undefined, "test");
    return json({ ok: true, lastPushAt: Number(await setting(env, "last_push_at")) || null });
  }

  if (path === "/audit" && method === "POST") {
    const { itemId } = await body(request);
    if (typeof itemId !== "string" || !/^\d{6,20}$/.test(itemId)) return json({ error: "Bad item id" }, 400);
    try {
      const job = await startJob(env, "listing_review", { itemId }, user.name);
      return json(job.status === "queued" ? job : job.result);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 503);
    }
  }

  // A background job's progress (src/background.ts).
  const jobPath = path.match(/^\/jobs\/(job_[\w-]{1,64})$/);
  if (jobPath && method === "GET") {
    const s = await jobStatus(env, jobPath[1]);
    return s ? json(s) : json({ error: "Not found" }, 404);
  }

  // The pricing engine on one listing (docs/pricing-engine.md). Read-only on eBay; spends sold-data
  // searches and a few Haiku calls, so owner only.
  if (path === "/pricing/check" && method === "POST") {
    if (!owner) return ownerOnly();
    const { itemId } = await body(request);
    if (typeof itemId !== "string" || !/^\d{6,20}$/.test(itemId)) return json({ error: "Bad item id" }, 400);
    return run(async () => {
      const job = await startJob(env, "price_check", { itemId }, user.name);
      return json(job.status === "queued" ? job : job.result);
    });
  }

  if (path === "/pricing/latest" && method === "GET") {
    const rows = await env.store.pricing.latestDecisions();
    return json(rows.map((r) => ({ item_id: r.item_id, at: r.at, strategy: r.strategy, price: r.price, total: r.total, predicted_days: r.predicted_days, result: JSON.parse(r.result) })));
  }

  if (path === "/pricing/advice" && method === "GET") {
    const rows = await env.store.pricing.openAdvice();
    return json(rows.map((r) => ({ id: r.id, at: r.at, ...JSON.parse(r.detail) })));
  }

  if (path === "/pricing/advice/dismiss" && method === "POST") {
    const { id } = await body(request);
    if (typeof id !== "string" || !/^[\w-]{1,40}$/.test(id)) return json({ error: "Bad id" }, 400);
    await env.store.pricing.dismissAdvice(id);
    return json({ ok: true });
  }

  // Inbox to-dos (src/todos.ts): what needs one of you but isn't an eBay change. None of these write to eBay:
  // an answer is saved as K's facts, and a Claude draft files ordinary proposals for approval.
  if (path === "/todos" && method === "GET") {
    const status = url.searchParams.get("status") ?? "open";
    if (!["open", "done", "dismissed", "resolved"].includes(status)) return json({ error: "Bad status" }, 400);
    const order = { answer: 0, claude: 1, you: 2 } as const;
    // Once, the first time: the to-dos from the audit report saved before to-dos existed (no eBay or Claude
    // calls; K's choice on 2026-11-05 rather than running the audit again).
    if (status === "open" && !(await env.store.todos.any())) {
      const report = await latestReport(env);
      if (report) await fileAuditTodos(env, report, Date.now());
    }
    const rows = await env.store.todos.list(status as "open");
    rows.sort((a, b) => (status === "open" ? order[a.kind] - order[b.kind] || a.created_at - b.created_at : (b.decided_at ?? 0) - (a.decided_at ?? 0)));
    return json(rows);
  }
  const todoPath = path.match(/^\/todos\/(todo:[\w-]{1,64})\/(done|dismiss|answer|claude)$/);
  if (todoPath && method === "POST") {
    const [, id, action] = todoPath;
    const todo = await env.store.todos.get(id);
    if (!todo) return json({ error: "Not found" }, 404);
    if (todo.status !== "open") return json({ error: "Already dealt with" }, 409);
    const now = Date.now();
    if (action === "done" || action === "dismiss") {
      await env.store.todos.close(id, action === "done" ? "done" : "dismissed", user.name, now);
      return json({ ok: true });
    }
    if (action === "answer") {
      // Facts are K's own words about K's items, so only K answers (as for the facts box).
      if (!owner) return ownerOnly();
      if (todo.kind !== "answer" || !todo.item_id) return json({ error: "This to-do doesn't take an answer" }, 400);
      const { text } = await body(request);
      const answer = typeof text === "string" ? text.trim().slice(0, 1000) : "";
      if (!answer) return json({ error: "Write an answer" }, 400);
      if (todo.code === "own_price") {
        // Nothing comparable has sold: K's price becomes the listing's own price. If the listing isn't at it, the
        // usual price proposal (floor, step and engine checks; K approves) puts it there.
        const price = parsePrice(answer);
        if (price == null) return json({ error: "Give a price, for example 65" }, 400);
        const itemId = todo.item_id;
        return run(async () => {
          await env.store.listings.setOwnPrice(itemId, price);
          await priceListing(env, itemId);
          const current = (await env.store.listings.latest(itemId))?.price ?? null;
          let note = `Saved: £${price.toFixed(2)} is this listing's price. The engine won't change it; clear it on Listings.`;
          if (current != null && Math.abs(current - price) / current >= 0.01) {
            const propose = tools.find((t) => t.name === "propose_price_change")!;
            await propose.run(env, { item_id: itemId, new_price: price, reason: "Your own price, set in the Inbox: nothing comparable has sold to price it from." });
            note += ` A label to change it from £${current.toFixed(2)} is waiting below.`;
          }
          await env.store.todos.close(id, "done", user.name, now, note);
          return json({ ok: true, note });
        });
      }
      const cur = await env.store.listings.getSettings(todo.item_id);
      const notes = [cur?.notes, answer].filter(Boolean).join("\n").slice(0, 2000);
      await env.store.listings.setFloorAndNotes(todo.item_id, cur?.floor_price ?? null, notes);
      // The engine prices it again with the answer; its result arrives by push.
      let note = "Saved as a fact about this listing.";
      if (todo.code === "engine_question")
        note = await startJob(env, "price_check", { itemId: todo.item_id }, user.name)
          .then(() => "Saved. The engine is pricing it again; you'll get a notification.")
          .catch(() => "Saved. Run a price check from Listings to use it.");
      await env.store.todos.close(id, "done", user.name, now, note);
      return json({ ok: true, note });
    }
    if (todo.kind !== "claude" || !todo.item_id) return json({ error: "This to-do isn't for Claude" }, 400);
    return run(async () => {
      await startJob(env, "listing_review", { itemId: todo.item_id }, user.name);
      const note = "Claude is reviewing it. Its changes arrive as labels to approve.";
      await env.store.todos.close(id, "done", user.name, now, note);
      return json({ ok: true, note });
    });
  }

  // The first-day audit (docs/listing-assistant.md). Reading the report is open to all three; running it
  // spends sold-data searches and a Claude call, so owner only. Read-only on eBay either way.
  if (path === "/firstday" && method === "GET") return json({ report: await latestReport(env) });
  if (path === "/firstday/run" && method === "POST") {
    if (!owner) return ownerOnly();
    const b = await body(request);
    return run(async () => {
      const job = await startJob(env, "firstday", { relearnStyle: b.relearnStyle === true }, user.name);
      return json(job.status === "queued" ? job : job.result);
    });
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
    const monthRows = await env.store.usage.since(month.getTime());
    const sum = async (since: number) => {
      const rows = monthRows.filter((r) => r.at >= since);
      return { usd: rows.reduce((s, r) => s + r.cost_usd, 0), calls: rows.length };
    };
    const jobs = new Map<string, { job: string; calls: number; usd: number }>();
    for (const r of monthRows) {
      const job = r.job.includes(":") ? r.job.slice(0, r.job.indexOf(":")) : r.job;
      const cur = jobs.get(job) ?? { job, calls: 0, usd: 0 };
      jobs.set(job, { job, calls: cur.calls + 1, usd: cur.usd + r.cost_usd });
    }
    const byJob = [...jobs.values()].sort((a, b) => b.usd - a.usd);
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
    // Orders and their items are added only if absent (a re-import changes nothing); counts items added.
    let imported = 0;
    for (const s of clean)
      imported += await env.store.orders.insertIfAbsent([
        {
          orderId: s.orderId,
          createdAt: Date.parse(`${s.date}T12:00:00Z`),
          total: Math.round((s.price * s.quantity + (s.shipping ?? 0)) * 100) / 100,
          fees: null,
          currency: "GBP",
          status: "IMPORTED",
          items: [{ itemId: s.itemId, title: s.title, quantity: s.quantity, price: Math.round(s.price * s.quantity * 100) / 100 }],
        },
      ]);
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

/** SQLite's SUM: null for no rows or only nulls. */
export function sqlSum(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((t, x) => t + x, 0) : null;
}
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Everything the Metrics screen draws, from the store only (no eBay or Claude calls). */
export async function metrics(env: Env) {
  const now = Date.now();
  const since = now - 90 * DAY;
  const since30 = now - 30 * DAY;

  // The last snapshot of each day.
  const snaps = await env.store.listings.snapshotsSince(since);
  const lastOfDay = new Map<string, number>();
  for (const r of snaps) lastOfDay.set(utcDay(r.taken_at), Math.max(lastOfDay.get(utcDay(r.taken_at)) ?? 0, r.taken_at));
  const byDay = new Map<string, typeof snaps>();
  for (const r of snaps) if (r.taken_at === lastOfDay.get(utcDay(r.taken_at))) byDay.set(utcDay(r.taken_at), [...(byDay.get(utcDay(r.taken_at)) ?? []), r]);
  const listings = [...byDay.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([day, rows]) => ({
      day,
      active: rows.length,
      asking: sqlSum(rows.map((r) => (r.price == null || r.quantity_available == null ? null : r.price * Math.max(r.quantity_available, 1)))),
      watchers: sqlSum(rows.map((r) => r.watch_count)),
    }));

  const orders = await env.store.orders.since(since);
  const salesDays = new Map<string, typeof orders>();
  for (const o of orders) salesDays.set(utcDay(o.created_at), [...(salesDays.get(utcDay(o.created_at)) ?? []), o]);
  const sales = [...salesDays.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([day, rows]) => ({ day, orders: rows.length, revenue: sqlSum(rows.map((o) => o.total)), fees: sqlSum(rows.map((o) => o.fees)) }));

  const usage = await env.store.usage.since(since);
  const spendDays = new Map<string, typeof usage>();
  for (const u of usage) spendDays.set(utcDay(u.at), [...(spendDays.get(utcDay(u.at)) ?? []), u]);
  const spend = [...spendDays.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([day, rows]) => ({ day, usd: sqlSum(rows.map((r) => r.cost_usd)), calls: rows.length }));

  // Sales in the last 30 days, one row per (order, item) as the old JOIN gave.
  const lines = orderLines(orders.filter((o) => o.created_at >= since30));
  const sold30 = {
    items: new Set(lines.map((l) => l.item_id)).size,
    revenue: sqlSum(lines.map((l) => l.total)) ?? 0,
    fees: sqlSum(lines.map((l) => l.fees)) ?? 0,
  };
  // Days from a listing's first start to its sale, for items sold in the last 30 days that were snapshotted.
  const latest = await env.store.listings.latestAll();
  const spans = lines
    .map((l) => {
      const start = latest.get(l.item_id)?.first_start_time;
      const ms = start ? Date.parse(start) : NaN;
      return Number.isFinite(ms) ? (l.created_at - ms) / DAY : null;
    })
    .filter((x): x is number => x != null);
  const avgDaysToSell = spans.length ? spans.reduce((t, x) => t + x, 0) / spans.length : null;

  const recent = await env.store.proposals.listWhere([{ f: "created_at", op: ">=", v: since30 }]);
  const proposals: Record<string, number> = {};
  for (const p of recent) proposals[p.status] = (proposals[p.status] ?? 0) + 1;
  const decideTimes = recent
    .filter((p) => p.decided_at != null && ["applied", "approved", "rejected", "failed"].includes(p.status))
    .map((p) => (p.decided_at! - p.created_at) / 60000)
    .sort((x, y) => x - y);

  const flags = (await env.store.jobs.latestHealthFlags()).map((f) => {
    const l = latest.get(f.item_id);
    return { item_id: f.item_id, flag: f.flag, detail: f.detail, title: l && l.taken_at ? l.title : null };
  });
  const lastNightly = await env.store.kv.getJson<any>("last_nightly");
  const active = listings.at(-1)?.active ?? 0;
  return {
    listings,
    sales,
    spend,
    sold30: { ...sold30, sellThrough: sold30.items + active > 0 ? sold30.items / (sold30.items + active) : null },
    avgDaysToSell,
    proposals,
    medianMinutesToDecide: decideTimes.length ? decideTimes[Math.floor(decideTimes.length / 2)] : null,
    flags,
    lastNightly,
  };
}
