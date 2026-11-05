# EBayManager

Automates K's eBay selling: improve existing listings, re-evaluate unsold ones, build new listings from photos, and draft buyer replies. K approves every change to the eBay account: every price, revision, ad rate, listing and buyer message.

Full plan (decisions, eBay API map, rollout): https://claude.ai/artifact/JowUE86DsPhFBsswMms8jf

Design docs: [roadmap](docs/roadmap.md), [pricing engine](docs/pricing-engine.md), [security](docs/security.md), [pricing and promotion](docs/pricing-and-promotion.md), [sold-price data](docs/sold-price-data.md), [listing assistant](docs/listing-assistant.md), [go-live tests](docs/go-live-tests.md), [safety and environments](docs/safety-and-environments.md), [approvals](docs/approvals.md), [app and dashboard](docs/app-and-dashboard.md).

## Decisions (2026-11-02)

- **Sandbox first.** Everything is built and tested on eBay Sandbox. K's real seller account is connected read-only at Phase 6 and accepts approved writes only from Phase 8. See [safety-and-environments.md](docs/safety-and-environments.md).
- **Every eBay write needs approval**, not only prices and messages. Strict at launch. Later, K may opt eligible kinds into auto-apply. See [approvals.md](docs/approvals.md).
- **One PWA is both the website and the app.** The dashboard is an installable Android PWA with Web Push Approve/Reject, served by the same Worker. ntfy becomes an optional fallback. See [app-and-dashboard.md](docs/app-and-dashboard.md).

## Stack

- TypeScript on Cloudflare Workers, with D1 (SQLite) for state and R2 for photos. Deployed with `wrangler`, with separate `sandbox` and `production` environments that each have their own D1 and R2.
- eBay: Trading API (XML) for existing listings, best offers and revisions; REST APIs (Browse, Inventory, Marketing, Negotiation, Analytics, Taxonomy) elsewhere. Marketplace is EBAY_GB, site ID 3. `EBAY_ENV` (`sandbox` | `production`) selects hosts and keyset.
- Claude: called from the Worker through the Anthropic API with K's key, using `@anthropic-ai/sdk`. This decision was made on 2026-11-01 and replaces the earlier plan to run on the Claude subscription. Use Claude Sonnet 5.5 (`claude-sonnet-5-5`) for listing builds and photo feedback. Use Claude Haiku 5.5 (`claude-haiku-5-5`) for nightly triage and buyer message drafts. The target spend is about $3 to $6 a month.
- Dashboard and PWA: Vite + Preact + TypeScript in `web/`, served as Workers static assets at the site root. K signs in with `DASHBOARD_KEY` (separate from `MCP_TOKEN`); `/api/*` needs that session cookie plus an `X-EbayManager` header. Cloudflare Access can be added in front later. Design: the tasteskill "quiet instrument" direction (Switzer, Frost and slate); its house rules apply to every screen.
- Notifications: Web Push (VAPID, implemented on Web Crypto in `src/push.ts`, no library) to the installed PWA, with signed Approve/Reject actions handled by `web/public/sw.js`. ntfy.sh is the fallback.
- The `/mcp` endpoint stays. It lets K use the same tools from the Claude app or Claude Code when they want to, but nothing depends on it.

## Decisions (2026-11-02, plan v3)

- **Three people only**: K (owner) and two managers, each signing in with a passkey; roles and the eBay call allowlist enforced in code. See [security.md](docs/security.md). Extreme focus on security.
- **Go live after one nightly read-only cycle** and the [go-live tests](docs/go-live-tests.md), not 7 days.
- **Everything needs approval at launch**, including titles, descriptions and specifics. Later, owner-only switches let those three apply automatically with a "Done" notification. Prices, offers, replies and promotion never auto-apply.
- **Prices, offers and promotion come from a market picture**: the same item in the same condition, postage-inclusive, with saturation and sold prices. Promotion only when it pays, below eBay's suggested rate. See [pricing-and-promotion.md](docs/pricing-and-promotion.md).

## Decisions (2026-11-03)

- **A learning pricing engine** replaces the fixed percentile rule: Claude identifies the item and checks every comparable, both sold-data providers are pooled, the market is classed (normal, race to the bottom, decline, thin), and the price maximises expected profit allowing for time to sell. It learns from listings that sell or sit. Bundles are priced as the sum of their parts, and weekly advice suggests combining or splitting listings. See [pricing-engine.md](docs/pricing-engine.md).
- **Never assume item facts**: look up specifications only for an exactly identified product, with sources; otherwise ask. Coach photos for someone new to selling. See [listing-assistant.md](docs/listing-assistant.md).
- **First-day audit** of listings, sold history, messages (reply style) and settings once the real account connects.
- **UI redesign** with the tasteskill: eBay-based colours made K's own, a logo, separate phone and desktop layouts with the same features.

## Rules that are enforced in code, never in prompts

These are in `src/rules.ts`. K confirmed the selling rules on 2026-10-12 and the approval rules on 2026-11-02.

- **Every eBay write needs approval.** Anything that changes the eBay account goes through a proposal (`src/proposals.ts`). It changes eBay only after K approves it from a push notification or the dashboard Inbox. Signed links work by POST only. Never add a tool or code path that writes to eBay directly.
- **Locked kinds.** `price`, `message`, `best_offer_response`, `offer_to_watchers`, `create_listing`, `end_listing`, `policy` and `promote` can never be auto-applied, whatever the dashboard settings say.
- **One write gate.** Only `ebayWrite()` in `src/ebay/write.ts` may call eBay write endpoints. It refuses unless `WRITE_MODE=approval`, the kill switch is off and the proposal is approved. Every write is recorded in `audit_log`.
- **Read-only until Phase 8.** K's real account is connected read-only (Phase 6). Never set `WRITE_MODE=approval` in production, or request write scopes, before Phase 8 and the go-live tests.
- **Pricing target.** The pricing engine (`src/pricing/`, [pricing-engine.md](docs/pricing-engine.md)) prices toward the cheaper end of current sales of the same item without going below its long-run value, holds at a higher price when a dip is temporary, and asks K when it can't identify the item. K's floor is enforced in code; the engine moves at most 10% a step, and a bigger jump or a second change within 7 days is flagged on the label. Updated by K on 2026-11-03.
- **Returns.** Always accepted, and the buyer pays return postage. This is set as an eBay business policy.
- **Shipping.** Assume K has a box and ships the item, unless they say collection only.
- **Negotiation.** K leads it. Claude only drafts replies, and K approves each message and counter-offer.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Routes: `/mcp`, `/oauth/start`, `/oauth/callback`, `/decide/:id`, `/health`, and the nightly cron |
| `src/ebay/hosts.ts` | Sandbox or production hosts from `EBAY_ENV`; the only place hosts are chosen |
| `src/ebay/write.ts` | The write gate: the only code that sends eBay writes; kill switch and audit log |
| `src/ebay/` (rest) | eBay OAuth, the read-only Trading API client, and Browse comps |
| `src/proposals.ts` | Proposals, signed expiring approval links, and deciding them |
| `src/tools.ts`, `src/mcp.ts` | Tool definitions and a minimal stateless MCP server |
| `src/notify.ts`, `src/push.ts` | Notifications: Web Push to the PWA (RFC 8291/8292), ntfy fallback |
| `schema.sql` | D1 schema |
| `test/` | Vitest: gate refusal paths (`gate.test.ts`), source scans keeping writes behind the gate (`safety.test.ts`) |
| `docs/` | Design docs and roadmap |
| `src/api.ts`, `src/session.ts` | Dashboard JSON API and K's sign-in session |
| `web/` | The dashboard PWA (Preact). `MOCK=1 npm run dev:web` runs it on sample data |
| `scripts/` | `make-keys.mjs` (DASHBOARD_KEY, VAPID_KEY into .dev.vars), `make-icons.mjs` |
| `src/claude.ts`, `src/jobs.ts` | Claude tool-use loop (allowlisted tools, cost log, daily budget) and the jobs that use it |
| `src/nightly.ts`, `src/health.ts`, `src/ebay/sell.ts` | The 02:00 run: snapshot, orders and traffic sync, rule-based health flags, Haiku triage of flagged listings |
| `src/pricing/` | The pricing engine: `model.ts` (maths, pure), `identify.ts` (Claude identify and match), `engine.ts`, `learn.ts`, `bundles.ts` |
| `src/solddata.ts`, `src/solddata-eval.ts`, `src/salesreport.ts` | Trawl and CompsAPI sold data (capped, cached), K's comparison test, the Seller Hub orders report import |
| `src/specs.ts` | Published specifications for an exactly identified product (Sonnet + web search), each with a verified source |
| `src/firstday.ts`, `src/style.ts`, `src/promotion.ts`, `src/ebay/history.ts` | First-day audit report, K's reply style guide, Promoted Listings research, and the account-history reads they use |
| `src/inbox.ts`, `src/ebay/inbox.ts` | The 15-minute poll: buyer questions and Best Offers, Haiku drafts, floor enforced in code |
| `src/todos.ts`, `src/store/todos.ts`, `web/src/todos.tsx` | Inbox to-dos: what needs K but isn't an eBay change, filed by the audit and the nightly ([approvals.md](docs/approvals.md)) |

## Commands

```sh
npm install
npm run typecheck && npm test   # tsc + vitest
npx wrangler dev                # local, Sandbox; secrets in .dev.vars
npm run deploy:sandbox          # Claude may run this
npm run deploy:production       # K runs this, then: node scripts/check-production.mjs
```

Production is read-only (`WRITE_MODE=off`). Claude can read production D1 for diagnosis (`npx wrangler d1 execute ebay-autopilot-production --env production --remote --json --command "SELECT ..."`), but K runs anything that changes production: deploys, migrations (`migrations/*.sql`, also appended to `schema.sql`) and secrets (`npx wrangler secret bulk .prod.vars --env production`). Never print secrets or `.prod.vars`.

## Where things stand (2026-11-03)

- Phases 0–6 are done. K's real eBay account is connected **read-only** to production: https://ebay-autopilot-production.ebay-autopilot.workers.dev (Sandbox: https://ebay-autopilot-sandbox.ebay-autopilot.workers.dev).
- The pricing engine is built (`src/pricing/`, [pricing-engine.md](docs/pricing-engine.md)). It prices listings, Best Offers and counters, audits and a nightly price review, and the code enforces that prices come from it. In K's backtest against 5 real sales it was 12.4% off on average (4 priced), against CompsAPI 27.1% and Trawl 77%.
- K's past sales (23, from 2025-03 to 2026-09) are imported from the Seller Hub orders report. eBay's APIs return only 90 days.
- **Current phase: 7, read-only on the real account.** Built: the first-day audit and report (`src/firstday.ts`, Audit screen), the reply style guide (`src/style.ts`, used by every draft) and promotion research (`src/promotion.ts`). Next: K runs the audit on production, then one full nightly cycle and go-live tests A to H ([go-live-tests.md](docs/go-live-tests.md)). See [roadmap.md](docs/roadmap.md).

## Open items

- Sold-price data: Marketplace Insights isn't available. Prices come from Trawl and CompsAPI, pooled, with hard monthly caps (Trawl 250, CompsAPI 100) and a 30-day cache ([sold-price-data.md](docs/sold-price-data.md)). Never scrape eBay or automate its website.
- The engine assumes 0% eBay final value fees (a UK private seller). Add a fee setting if K sells as a business.
- No CI is set up yet.
