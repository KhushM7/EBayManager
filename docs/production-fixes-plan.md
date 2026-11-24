# Production fixes and selling features: plan (2026-11-24)

Status: **built 2026-11-24 and on Sandbox**; the decisions taken are in CLAUDE.md. Branch `production-fixes`, from `main` at 8384a01. Written from five read-only investigations of production (Cosmos, App Insights, code) and eBay's documentation. The repository is public: no buyer, order or account details here.

Evidence labels: **proven** (seen in data, logs or code), **inferred** (follows from the code, not observed), **unknown**.

## Ground rules

- Every eBay write stays proposal → approval → `ebayWrite()` → audit. New kinds are locked. The allowlist, `docs/security.md` and `test/safety.test.ts` change together.
- Works with Claude off (`CLAUDE_DAILY_BUDGET_USD=0` is live). Nothing that costs to run.
- No new Cosmos container: existing ones and their indexes are used.
- Each phase: typecheck and tests, Sandbox deploy, check, K deploys production.

## Root causes

| Problem | Cause | Evidence |
| --- | --- | --- |
| Unrelated bundles | The schema has no "related" verdict, so Claude's "not recommended" answers are accepted if the sums pass | proven |
| Absurd bundle figures | Days to sell is unbounded (`1/hazard`, up to billions); 2p a day is charged on it; ×1.05 of a negative makes the test easier | proven |
| Board-games gain | Mostly the wait cost: charged per item apart, once together. Parcel cost is never used | proven |
| Advice lingering / returning | Stays open until the next run about 6 days later. Dismissals aren't read by later runs | proven |
| "Help buyers find this listing" | `fileHealthTodos` files every flag without an open label, ignoring the ladder | proven |
| Reopened after its fix | An applied revision no longer counts as a label, and only price changes hold flags back | proven |
| Triage misses listings | `flagged.slice(0, 5)` counts listings the ladder will skip | proven |
| Ladder dead ends | No eligible watchers, no promotable market or low pricing confidence: the rung never finishes | proven in code; the offer rung seen live |
| Sales not shown | Synced nightly only; no list, badge, to-do or push | proven |
| Offers not shown | Poll runs and records none. What eBay returned isn't stored | cause unknown |
| Missing suggestions | Labels are all kept. Closed to-dos and advice have no screen; to-dos are overwritten on reopening | proven |
| Logs missing | Azure.Identity/Azure.Core info traces fill the 0.15 GB cap by about 04:20 UTC; blind until 21:00 | proven |

Offer candidates: answered between 15-minute polls; `Active` excludes `Pending`; account-wide call incomplete or returning a warning (only `Ack=Failure` throws); not formal Best Offers. No paging and no `Role` filter either.

**Related risk (proven in code, not triggered):** the same unbounded wait drives `expectedValue` towards -£20. `answerOffer` turns that into 0, so without a floor it can recommend accepting a very low offer. Fix before offers start appearing.

## Phase 0: stop the harm (one small release)

1. `host.json`: default `Warning`; `Azure.Core` `Error`; keep Information for the app's own poll, nightly, background and HTTP lines; Live Metrics and performance counters off; never sample exceptions. Prove on Sandbox by measuring volume per category after an hour.
2. One `claudeAvailable(env)` (key set and budget above 0). Triage and bundles return "skipped: Claude is off" instead of failing or clearing advice. Claude to-do actions refuse and stay open.
3. `fileHealthTodos` stops filing generic flag to-dos; the open one resolves on the next run.
4. `MAX_DAYS = 365`: beyond it, or not finite, days to sell is null ("no reliable estimate"), sanitised on read as well because stored documents keep old values.
5. Bundle advice filtered on read: hide it if an item isn't live, a figure is negative or not finite, the wait is over 365 days, the reason itself says unrelated, or it's over 14 days old.
6. `answerOffer`: no reliable estimate means it never suggests accept; K's floor and value floor still apply.

Tests: replay both production bundle cases; the Dyson inputs give null days; expected value -20 doesn't accept a low offer; budget 0 leaves advice untouched.

## Phase 1: sales, offers and messages

1. **Diagnose**: each call records ack, warnings, returned, kept and pages; last 100 polls kept, no buyer data.
2. **Read**: page the account-wide call, drop `Role=Buyer`, keep `Status`; also `GetBestOffers` per live listing with `All`, merged by offer id. Poll every 5 minutes; service and allowance checks stay at 15. Refresh button.
3. **Record first**, then draft and notify. Per-item try/catch, so one bad item can't block the rest. Reconcile with eBay: answered, expired or withdrawn offers close their label.
4. **Expiry** shown on the card; the gate refuses an expired offer.
5. **Offers and messages screen**: live and past; accept, counter (own amount), decline, reply. Below the floor: a clear warning, K may still choose it.
6. **Sales**: the poll reads recent orders; one push and one dispatch to-do per new order, a Sales list and a Sold label. First run doesn't alert on old orders. No buyer fields stored.
7. **Free-form messages**: Message API (`getConversations`, `getConversation`, `send_message`), new locked kind, scope `commerce.message`, so K reconnects eBay. Confirm path and scope on Sandbox first.
8. Check whether a Best Offer's `Price` is the buyer's or the seller's figure before comparing it with the floor.

Keep Trading `GetBestOffers`/`RespondToBestOffer`: neither is on eBay's deprecation list. Put them behind one interface so the new GraphQL Offer API (`sellerNegotiationHistory`, `acceptOffer`, `counterOffer`, `declineOffer`) can replace them. eBay's `OFFER_ACTIVITY` notifications are a later option.

Done when one real offer and one real question have been handled from the app (go-live tests G2, G3, I5).

## Phase 2: suggestions that can be acted on

- The ladder decides; flags only inform (Listings and Insights).
- The ladder takes feasibility: can edit, can offer, can promote, can price. Unseen: listing → promote → price. Watched: offer → price. Nothing feasible: say nothing. A failed eligibility check waits; it never becomes a price cut.
- The triage cap applies after filtering to listings it can act on.
- Hold back after any recent sales label; resolve to-dos when a label is filed, applied or the item sells; honest age after reopening; plurals.
- Invariant test: every nightly to-do names a concrete task.

## Phase 3: history

- Inbox: **To decide** and **History**. Expired, Refused and Rejected go: together they hold 11 rows.
- Held, sending and failed labels stay at the top of To decide (held and sending have no tab today).
- History covers labels, to-dos and advice with one plain outcome, filters, search and paging.
- Append-only `suggestion_event` documents in the same partition as what they describe, written in the same batch: filed, seen, approved, applied, rejected, dismissed, superseded, lapsed, sold, ended, reopened; who and why. No buyer text; `forgetUser` scrubs them.
- To-do and advice queries must filter on `type`, or events would be read as to-dos.
- Backfill what exists, marked as backfilled, unknown reasons said as unknown. Background job results have a 30-day TTL and start disappearing about **2026-12-05**: copy them first.

## Phase 4: logs and monitoring

- `src/log.ts`: structured, never throws, allowlisted fields, redacts tokens and buyer data.
- Events in the `jobs` container (per-document TTL, already indexed): nightly steps, poll failures and an hourly heartbeat, job outcomes, HTTP errors, swallowed errors. 14 days info, 90 days warnings and errors.
- Replace the harmful `.catch(() => null)`s, first in `write.ts`, `proposals.ts`, `inbox.ts`, `pricing/engine.ts`, `deletion.ts`.
- A step that fails must be reported as failed: today it is recorded as Succeeded.
- Dead-man checks: poll watches nightly, nightly watches poll, the account-deletion handler watches both. A free GitHub Actions check covers the whole app being down.
- Lower the two log caps to 0.1 and 0.05 GB (Bicep, K runs it): they share one 5 GB monthly allowance, already passed this month.
- `scripts/logs.mjs` for diagnosis; a small "Last runs" block in Settings → Usage and APIs, owner only.
- No log-search alerts or availability tests: not shown to be free.

## Phase 5: bundles

eBay's **Bundle discounts** do what K wants: separate listings, buyer mixes and matches, a percentage off for 2, 3 and 4+ items, per-listing exclusions. Limits: shop-wide (no named groups found), being phased in, no API found. The Marketing API documents order, volume, coupon and markdown discounts; eBay UK help limits Discounts Manager to business sellers with a Shop.

**Bundle assistant (advice and a guided to-do, no write):**
- Related groups by rules: product group, category, brand, accessory-of; K can edit a group. Nothing on a price K set alone, spares or repair, or mixed collection-only and posted.
- Tier percentages tested against every included item's floor and a minimum gain, with waits ignored, so it can't be the old artefact. Combined postage considered.
- A to-do with the tiers, the listings to exclude and eBay's steps; K marks it done; new listings that should be excluded are flagged.
- Orders with several items are counted, to show whether it pays.
- Old "Sell together" combined-listing advice is removed. Dismissed groups stay dismissed.
- When Bundle discounts isn't on the account: optional "goes with" wording in related listings as normal `revise` labels. Check eBay's links policy first; wording only until then.

**If K has a business account and Shop:** a locked `bundle_discount` kind using `createItemPromotion` (listing ids, quantity tiers). Confirm on Sandbox that different listings count together: not confirmed by the pages read.

## Phase 6: other selling features

| Feature | Decision |
| --- | --- |
| Auto-decline price | Build if K agrees: per-listing label, at or below the floor, categories that support it. Auto-accept stays off |
| Offers to watchers and abandoned carts | Built; record eBay's eligibility reply, prove with one real label |
| Promoted Listings, cost per sale | Built; keep 2% to 4%. Check attribution in the 14-day review |
| Pay-per-click and offsite ads | No: charged without a sale |
| Combined postage (Account API v2) | Later: Simple Delivery combines at checkout already |
| Sale events, order discounts, multi-buy, coupons, shop emails | Only with a business Shop |
| eBay's own seller offers (`seller_promotional_offers`) | Read-only look first: may surface fee promotions; activation would be a locked kind |
| Purchase quotes (combine unpaid items) | Later: only for items bought but not paid for |

## Order and agents

Phase 0 first and alone. Then 1 (backend, then screen) and 4 (logging helper) in parallel worktrees; 2 and 3 after 1 because they share `inbox.ts`, `nightly.ts`, `todos.ts` and `screens.tsx`; then 5 and 6. One reviewer agent per phase checks the gate, privacy and tests before Sandbox.

## Decisions needed from K

1. Private or business account; Shop or not.
2. Whether Bundle discounts appears in My eBay.
3. Auto-decline below the floor: yes or no.
4. Claude stays off?
5. How many items sold, and how the offers arrived.
6. One read-only production `GetBestOffers` check on the sold items.
7. Reconnecting eBay for the messaging permission.

## Not verified

- `createItemPromotion` method details, GraphQL Offer scopes and statuses, and the notification topics (read through summaries only).
- Any API for Bundle discounts: none found, which isn't proof there is none.
- Whether the post-07:32 UTC deploy has errors: production logging is blind until 21:00 UTC.
- Log cost in pounds: the volumes were checked twice, the charge once.
