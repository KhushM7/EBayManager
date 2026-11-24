import type { Env } from "./env";
import { MODELS, runAgent } from "./claude";
import { getRecentOrders, getTraffic7d } from "./ebay/sell";
import { healthFlags, type Flag, type ListingFacts } from "./health";
import { AUDIT_TOOLS } from "./jobs";
import { push } from "./notify";
import { closeForEnded } from "./history";
import { expireStale, holdsListing } from "./proposals";
import { snapshotListings } from "./snapshot";
import { learnParams } from "./pricing/learn";
import { reviewBundles } from "./bundles";
import { reviewPrices, type ReviewOut } from "./pricing/review";
import { closeStaleTodos, fileOwnPriceReminders, filePriceQuestions, lastSentence } from "./todos";
import { checkPromotions, reviewPromotions, reviewRunningPromotions, type PromotionCheck } from "./promotion";
import { ladderFor, ladderSummary, type LadderStep, type TriageMemory } from "./ladder";
import { getEligibleForOffers, type EligibleForOffers } from "./ebay/sell";
import { log, swallow } from "./log";
import { claudeAvailable } from "./rules";
import { reviewWatcherOffers } from "./watchers";
import { checkAllowances } from "./allowance";
import { checkServices } from "./services";
import { providerEnabled } from "./solddata";
import { auditDone, runFirstDayAudit } from "./firstday";
import { cleanUpDrafts } from "./drafts";
import { writeExports } from "./ro/export";

// The 02:00 run: read eBay, score listing health by rule, and send only flagged listings to Haiku, which may
// file proposals for K. Each step runs on its own, so one failure (Sandbox has no traffic data, say) doesn't
// stop the rest. The outcome is kept in settings.last_nightly for the Metrics screen.

const MAX_TRIAGED_PER_NIGHT = 5;
/** How long an unchanged listing keeps its last triage instead of being triaged again (as REVISE_QUIET_DAYS). */
const TRIAGE_REUSE_MS = 7 * 86_400_000;
/** A change proposed this recently (waiting, approved, agreed as a dry run, or applied) isn't redone by triage. */
export const REVISE_QUIET_DAYS = 7;

/**
 * Listings with a recent listing edit: triage mustn't propose another. While changes are off an approved dry
 * run doesn't change eBay, so triage would otherwise read the old listing and undo K's approved edit (2026-11-05:
 * a review removed unsupported specifics from the Maono listing and the same night's triage put them back).
 */
export async function recentlyRevised(env: Env, now: number, kind: "revise" | "price" = "revise"): Promise<Set<string>> {
  const rows = await env.store.proposals.listWhere([
    { f: "kind", op: "=", v: kind },
    { f: "status", op: "in", v: ["pending", "approved", "agreed", "applied"] },
    { f: "created_at", op: ">", v: now - REVISE_QUIET_DAYS * 86_400_000 },
  ]);
  return new Set(rows.filter((p) => holdsListing(env, p)).map((p) => p.item_id).filter((x): x is string => Boolean(x)));
}

export const TRIAGE_SYSTEM = `A nightly rule check flagged one of K's eBay UK listings. Decide whether one small change would help it sell, and if so propose it. You cannot change eBay: propose_* tools record proposals that K approves or rejects.

K's rules, also enforced in code: prices come from price_check (the pricing engine), never from asking prices alone; propose its price only if it differs by 5% or more and its confidence is at least 0.3, with its strategy and why as the reason; if it says ask, put its question in your note. Returns accepted with the buyer paying return postage; never invent facts about the item.

Guide by flag:
- stale (no watchers after 30 days): the title or price is usually the problem. Run price_check; propose a better title, or its price if the market supports a change.
- watched_not_selling: the price is slightly high. Run price_check and propose its price if it supports a change.
- low_views: the title and item specifics aren't matching searches. Propose a clearer title and missing specifics.
- low_click_through: the price or main photo looks wrong in search. Run price_check; mention the photo in your note.

Make at most one proposal, or none if nothing clearly helps. End with one sentence for K.`;

export interface NightlyResult {
  at: number;
  steps: Record<string, string>;
  flagged: { itemId: string; flags: Flag[] }[];
  triaged: number;
  proposals: number;
  /** Each step in order, with whether it worked. */
  runs: StepRun[];
  /** Names of the steps that failed: empty when the night went well. */
  failed: string[];
}

export interface StepRun {
  name: string;
  ok: boolean;
  outcome: string;
  ms: number;
}

/** Where each run's steps are recorded, besides the plain name-to-outcome list the app shows. */
const recorders = new WeakMap<Record<string, string>, (r: StepRun, err?: unknown) => Promise<void>>();

async function step(steps: Record<string, string>, name: string, fn: () => Promise<string>) {
  const start = Date.now();
  let ok = true;
  let err: unknown;
  try {
    steps[name] = await fn();
  } catch (e) {
    ok = false;
    err = e;
    steps[name] = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  }
  await recorders.get(steps)?.({ name, ok, outcome: steps[name], ms: Date.now() - start }, err);
}

/** Errors that mean no later Claude call tonight can work either. */
const CLAUDE_DONE = /Claude is switched off|Claude budget|ANTHROPIC_API_KEY/i;

export async function listingFacts(env: Env): Promise<ListingFacts[]> {
  const open = await env.store.proposals.listWhere([{ f: "status", op: "in", v: ["pending", "approved"] }]);
  const appliedPrices = await env.store.proposals.listWhere([
    { f: "kind", op: "=", v: "price" },
    { f: "status", op: "=", v: "applied" },
  ]);
  const changes = await env.store.proposals.listWhere([
    { f: "kind", op: "in", v: ["revise", "price", "offer_to_watchers", "promote"] },
    { f: "status", op: "=", v: "applied" },
  ]);
  const results = (await env.store.listings.latestSet()).map((l) => ({
    ...l,
    last_change: Math.max(0, ...changes.filter((p) => p.item_id === l.item_id).map((p) => p.decided_at ?? 0)) || null,
    pending: open.filter((p) => p.item_id === l.item_id).length,
    last_price_change: appliedPrices.filter((p) => p.item_id === l.item_id).reduce<number | null>((m, p) => (p.decided_at != null && (m == null || p.decided_at > m) ? p.decided_at : m), null),
  }));
  return results.map((r) => ({
    itemId: r.item_id,
    title: r.title,
    price: r.price,
    watchCount: r.watch_count ?? 0,
    startTime: r.start_time,
    views7d: r.views_7d,
    impressions7d: r.impressions_7d,
    pendingProposals: r.pending,
    lastPriceChangeAt: r.last_price_change,
    lastChangeAt: r.last_change,
  }));
}

export async function runNightly(env: Env): Promise<NightlyResult> {
  const at = Date.now();
  const steps: Record<string, string> = {};
  const runs: StepRun[] = [];
  const runId = `nightly-${at}`;
  recorders.set(steps, async (r, err) => {
    runs.push(r);
    // A step can finish and still carry a part that failed ("3 checked; ... failed"): worth a warning.
    const partly = r.ok && /\bfailed\b|request failed|access denied/i.test(r.outcome);
    await log(env, r.ok ? (partly ? "warn" : "info") : "error", `nightly.${r.name}`, { job: "nightly", runId, ms: r.ms, detail: r.outcome, ...(err === undefined ? {} : { err }) });
  });

  await step(steps, "snapshot", async () => `${(await snapshotListings(env)).count} listings`);
  await step(steps, "expire", async () => (await expireStale(env), "done"));
  await step(steps, "orders", async () => {
    const orders = await getRecentOrders(env);
    await env.store.orders.upsertFromApi(orders);
    return `${orders.length} orders`;
  });
  await step(steps, "traffic", async () => {
    const rows = await getTraffic7d(env);
    await env.store.listings.writeTraffic(at, rows);
    return `${rows.length} listings`;
  });

  const flagged: NightlyResult["flagged"] = [];
  await step(steps, "health", async () => {
    for (const l of await listingFacts(env)) {
      const flags = healthFlags(l, at);
      if (flags.length) flagged.push({ itemId: l.itemId, flags });
    }
    if (flagged.length)
      await env.store.jobs.recordHealthFlags(
        at,
        flagged.flatMap((f) => f.flags.map((fl) => ({ item_id: f.itemId, flag: fl.flag, detail: fl.detail }))),
      );
    return `${flagged.length} flagged`;
  });

  // The pricing engine re-prices a few listings and proposes changes the market supports, before triage,
  // so triage sees those proposals as pending and doesn't repeat them.
  // Its questions become Inbox to-dos for the listings it priced (src/todos.ts).
  // The sales ladder (src/ladder.ts): each listing's one step tonight. The steps below act only on their rung.
  // What can be done tonight is found out first, so no listing is put on a rung that leads nowhere.
  let eligible: EligibleForOffers | null = null;
  await step(steps, "eligible_offers", async () => {
    eligible = await getEligibleForOffers(env);
    return `${eligible.ids.length} eligible; eBay's reply: ${eligible.reply}`;
  });
  let promos: PromotionCheck | null = null;
  await step(steps, "promotion_check", async () => {
    promos = await checkPromotions(env);
    const advice = promos.found.map((p) => `${p.itemId}: ${p.advice.action}, ${p.advice.why}`.slice(0, 90)).join("; ");
    return `${promos.found.length} checked${advice ? ` (${advice})` : ""}`.slice(0, 900);
  });
  let ladder: Map<string, LadderStep> | undefined;
  await step(steps, "ladder", async () => {
    const e = eligible as EligibleForOffers | null;
    const p = promos as PromotionCheck | null;
    ladder = await ladderFor(env, at, {
      eligible: e && new Set(e.ids),
      promotable: p && new Set(p.found.filter((x) => x.advice.action === "promote").map((x) => x.itemId)),
    });
    for (const [itemId, s] of ladder) await log(env, "info", "ladder.step", { job: "nightly", runId, itemId, detail: `${s.rung}: ${s.why}` });
    return ladderSummary(ladder);
  });

  const review: ReviewOut = { priced: [], asked: [] };
  await step(steps, "prices", async () => {
    if (!providerEnabled(env, "trawl") && !providerEnabled(env, "compsapi")) return "skipped: no sold-data provider keys";
    const out = await reviewPrices(env, at, { out: review, ladder });
    await filePriceQuestions(env, review.priced, review.asked, at);
    return out;
  });

  // Promotion research on the listings the engine has a market picture for (docs/pricing-and-promotion.md).
  await step(steps, "promotion", async () => reviewPromotions(env, ladder, promos ?? undefined));
  // Ads that have run 14 days: are more people seeing the listing? If not, an "end" label.
  await step(steps, "promotion_review", async () => reviewRunningPromotions(env, at));

  // A small offer to the watchers of listings that have them (src/watchers.ts): a reminder.
  await step(steps, "watcher_offers", async () => reviewWatcherOffers(env, at, ladder, eligible));

  // Claude credit and sold-data searches running low or out: an Inbox to-do and a notification.
  await step(steps, "allowances", async () => checkAllowances(env));

  let triaged = 0;
  await step(steps, "triage", async () => {
    if (!env.ANTHROPIC_API_KEY) return "skipped: no ANTHROPIC_API_KEY";
    if (!claudeAvailable(env)) return "skipped: Claude is off";
    const revised = await recentlyRevised(env, at);
    const repriced = await recentlyRevised(env, at, "price");
    const pending = await env.store.proposals.listByStatus("pending", "asc");
    let reused = 0;
    let onLadder = 0;
    const failures: string[] = [];
    let stopped = "";
    // Listings on the ladder's "listing" step go to Claude even when no health rule flagged them, or that step
    // would never be taken.
    const candidates: { itemId: string; flags: { flag: string; detail: string }[]; last: TriageMemory | null }[] = [];
    const unflagged = [...(ladder ?? [])]
      .filter(([id, s]) => s.rung === "listing" && !flagged.some((f) => f.itemId === id))
      .map(([itemId, s]) => ({ itemId, flags: [{ flag: "low_views", detail: s.why }] }));
    for (const f of [...flagged, ...unflagged]) candidates.push({ ...f, last: await env.store.kv.getJson<TriageMemory>(`triage:${f.itemId}`).catch(() => null) });
    // Least recently looked at first, and the cap counts only listings Claude is actually asked about.
    candidates.sort((x, y) => (x.last?.at ?? 0) - (y.last?.at ?? 0));
    for (const f of candidates) {
      if (triaged + failures.length >= MAX_TRIAGED_PER_NIGHT) break;
      // The sales ladder: triage may propose a listing edit only when the listing itself is this item's step
      // tonight, and a price only when the price is (the price review normally files that one first).
      const rung = ladder?.get(f.itemId)?.rung;
      const noEdit = revised.has(f.itemId) || (rung != null && rung !== "listing");
      const noPrice = repriced.has(f.itemId) || (rung != null && rung !== "price");
      // Nothing triage could propose tonight (an offer or an ad is this listing's step, or it's waiting on one):
      // no Claude run.
      if (noEdit && noPrice && rung != null) {
        onLadder++;
        continue;
      }
      // A listing triaged in the last week with nothing changed since (same flags, title, price, K's settings,
      // labels waiting and edit limits) keeps that night's note instead of the same run again.
      const l = await env.store.listings.latest(f.itemId);
      const s = await env.store.listings.getSettings(f.itemId);
      const fingerprint = JSON.stringify([
        f.flags.map((x) => x.flag).sort(),
        l?.title ?? null,
        l?.price ?? null,
        s?.floor_price ?? null,
        s?.notes ?? null,
        pending.filter((p) => p.item_id === f.itemId).map((p) => p.id),
        noEdit,
        noPrice,
      ]);
      if (f.last && f.last.fingerprint === fingerprint && at - f.last.at < TRIAGE_REUSE_MS) {
        reused++;
        continue;
      }
      try {
        const r = await runAgent(env, {
          job: `triage:${f.itemId}`,
          model: MODELS.triage,
          system: TRIAGE_SYSTEM,
          prompt:
            `Listing ${f.itemId} was flagged:\n${f.flags.map((x) => `- ${x.flag}: ${x.detail}`).join("\n")}` +
            (noEdit ? "\nDon't propose a listing edit for it tonight: one was proposed in the last week, or another step comes first." : "") +
            (noPrice ? "\nDon't propose a price change for it tonight: one was proposed in the last week, or another step comes first." : ""),
          toolNames: AUDIT_TOOLS.filter((t) => !(noEdit && t === "propose_listing_revision") && !(noPrice && t === "propose_price_change")),
          maxTurns: 6,
          effort: "low",
        });
        const note = lastSentence(r.text);
        await log(env, "info", "triage.result", { job: "nightly", runId, itemId: f.itemId, detail: `${r.stopReason}: ${note}` });
        // Only a run that finished is remembered; one cut short (turn limit, budget) runs again next night.
        if (r.stopReason === "end_turn") await env.store.kv.set(`triage:${f.itemId}`, JSON.stringify({ at, fingerprint, note: note ?? "", edit: !noEdit } satisfies TriageMemory)).catch(swallow(env, "triage.memory", { itemId: f.itemId }));
        triaged++;
      } catch (e) {
        // One listing's failure doesn't lose the rest; Claude being off or out of budget ends it for tonight.
        await log(env, "warn", "triage.failed", { job: "nightly", runId, itemId: f.itemId, err: e });
        const msg = e instanceof Error ? e.message : String(e);
        if (CLAUDE_DONE.test(msg)) {
          stopped = msg;
          break;
        }
        failures.push(`${f.itemId}: ${msg}`.slice(0, 120));
      }
    }
    if (failures.length && !triaged) throw new Error(`no listing could be triaged: ${failures.join("; ")}`);
    return `${triaged} of ${candidates.length} triaged${reused ? `, ${reused} unchanged since last week's check` : ""}${onLadder ? `, ${onLadder} on another step of the ladder` : ""}${failures.length ? `; failed ${failures.join("; ")}` : ""}${stopped ? `; stopped: ${stopped}` : ""}`;
  });

  // To-dos that no longer apply close; a flag alone never becomes one (src/todos.ts).
  // Labels and to-dos whose listing has sold or ended close, saying which (src/history.ts).
  await step(steps, "ended", async () => closeForEnded(env, at));

  await step(steps, "todos", async () => {
    const rows = await env.store.listings.latestSet();
    const live = rows.map((l) => ({ itemId: l.item_id, title: l.title }));
    if (!live.length) return "skipped: no listings read";
    const r = await closeStaleTodos(env, live, at);
    // Listings on K's own price get a reminder after 30 days unsold.
    const own = await fileOwnPriceReminders(
      env,
      rows.map((l) => ({ itemId: l.item_id, title: l.title, price: l.price, watchers: l.watch_count ?? 0, views7d: l.views_7d ?? null })),
      await env.store.listings.settingsAll(),
      at,
    );
    return `${r.opened + own.opened} opened, ${r.resolved + own.resolved} resolved`;
  });

  // The pricing engine learns from what sold (docs/pricing-engine.md, step 7), then looks for bundles.
  await step(steps, "learn", async () => {
    const r = await learnParams(env, at);
    return `${r.outcomes} outcomes, ${r.groups} groups`;
  });
  await step(steps, "bundles", async () => reviewBundles(env, at));

  // New-listing drafts untouched for 30 days are abandoned and their photos deleted (docs/add-listing.md).
  await step(steps, "drafts", async () => cleanUpDrafts(env, at));

  // The first-day audit runs once, on the first night after the account connects (or K runs it from the app).
  await step(steps, "first_day_audit", async () => {
    if (await auditDone(env)) return "already done";
    const r = await runFirstDayAudit(env);
    return `${r.findings.length} findings, ${r.proposals.length} proposals`;
  });

  // The Power BI export files (docs/power-platform.md): the read-only tables as CSV, with no buyer details.
  await step(steps, "exports", async () => writeExports(env, Date.now()));

  // Last, so it sees every call this run made: a service that's down (eBay sign-in, Claude, sold data) becomes
  // an Inbox to-do with a notification (src/services.ts).
  await step(steps, "services", async () => checkServices(env));

  const made = (await env.store.proposals.listWhere([{ f: "created_at", op: ">=", v: at }])).length;
  const failed = runs.filter((r) => !r.ok).map((r) => r.name);
  await log(env, failed.length ? "error" : "info", "nightly.done", { job: "nightly", runId, ms: Date.now() - at, detail: `${runs.length} steps, ${failed.length ? `failed: ${failed.join(", ")}` : "all worked"}; ${flagged.length} flagged, ${triaged} triaged, ${made} proposed` });
  const result: NightlyResult = { at, steps, flagged, triaged, proposals: made, runs, failed };
  await env.store.kv.setJson("last_nightly", result);
  if (result.proposals) await push(env, `Nightly check: ${result.proposals} to review`, `${flagged.length} listings flagged.`, undefined, "nightly");
  return result;
}
