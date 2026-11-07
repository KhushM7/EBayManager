# EBayManager

Automates K's eBay selling: improve existing listings, re-evaluate unsold ones, build new listings from photos, and draft buyer replies. K approves every change to the eBay account: every price, revision, ad rate, listing and buyer message.

Full plan (decisions, eBay API map, rollout): https://claude.ai/artifact/JowUE86DsPhFBsswMms8jf

Design docs: [roadmap](docs/roadmap.md), [design system](docs/design-system.md), [pricing engine](docs/pricing-engine.md), [security](docs/security.md), [pricing and promotion](docs/pricing-and-promotion.md), [sold-price data](docs/sold-price-data.md), [listing assistant](docs/listing-assistant.md), [go-live tests](docs/go-live-tests.md), [safety and environments](docs/safety-and-environments.md), [approvals](docs/approvals.md), [app and dashboard](docs/app-and-dashboard.md).

## Decisions (2026-11-02)

- **Sandbox first.** Everything is built and tested on eBay Sandbox. K's real seller account is connected read-only at Phase 6 and accepts approved writes only from Phase 8. See [safety-and-environments.md](docs/safety-and-environments.md).
- **Every eBay write needs approval**, not only prices and messages. Strict at launch. Later, K may opt eligible kinds into auto-apply. See [approvals.md](docs/approvals.md).
- **One PWA is both the website and the app.** The dashboard is an installable Android PWA with Web Push Approve/Reject, served by the same app as the backend. ntfy becomes an optional fallback. See [app-and-dashboard.md](docs/app-and-dashboard.md).

## Stack

- TypeScript on Azure (moved from Cloudflare on 2026-11-05, [azure-migration.md](docs/azure-migration.md)): Azure Functions on Flex Consumption (France Central), Cosmos DB for NoSQL (free tier: one account, databases `ebay-sandbox` and `ebay-production`), Blob Storage for photos, Key Vault for secrets, a Storage Queue for background jobs. Infrastructure is Bicep (`infra/`); `sandbox` and `production` are separate resource groups that share only the Cosmos account, each app reaching only its own database through its managed identity.
- eBay: Trading API (XML) for existing listings, best offers and revisions; REST APIs (Browse, Inventory, Marketing, Negotiation, Analytics, Taxonomy) elsewhere. Marketplace is EBAY_GB, site ID 3. `EBAY_ENV` (`sandbox` | `production`) selects hosts and keyset.
- Claude: called from the app (server side) through the Anthropic API with K's key, using `@anthropic-ai/sdk`. This decision was made on 2026-11-01 and replaces the earlier plan to run on the Claude subscription. Use Claude Sonnet 5.5 (`claude-sonnet-5-5`) for listing builds and photo feedback. Use Claude Haiku 5.5 (`claude-haiku-5-5`) for nightly triage and buyer message drafts. The target spend is about $3 to $6 a month.
- Dashboard and PWA: Vite + Preact + TypeScript in `web/`, served by the same Function App at the site root. People sign in on a hidden page (`/s/<SIGNIN_PATH>`) with their email and an authenticator-app code (Sandbox also allows `DASHBOARD_KEY`, never production); everyone else gets a blank 404 everywhere. `/api/*` needs the session cookie plus an `X-EbayManager` header. Design: [design-system.md](docs/design-system.md), a pro-consumer "glass and glow" look in Tailwind v4 and Framer Motion (K, 2026-11-05). The tasteskill house rules no longer bind the dashboard.
- Notifications: Web Push (VAPID, implemented on Web Crypto in `src/push.ts`, no library) to the installed PWA, with signed Approve/Reject actions handled by `web/public/sw.js`. ntfy.sh is the fallback.
- The `/mcp` endpoint stays. It lets K use the same tools from the Claude app or Claude Code when they want to, but nothing depends on it.

## Decisions (2026-11-02, plan v3)

- **Three people only**: K (owner) and two managers, set only by K with `scripts/people.mjs` (never from the app), each signing in with email and authenticator code (changed from passkeys on 2026-11-07); roles and the eBay call allowlist enforced in code. See [security.md](docs/security.md). Extreme focus on security.
- **Go live after one nightly read-only cycle** and the [go-live tests](docs/go-live-tests.md), not 7 days.
- **Everything needs approval at launch**, including titles, descriptions and specifics. Later, owner-only switches let those three apply automatically with a "Done" notification. Prices, offers, replies and promotion never auto-apply.
- **Prices, offers and promotion come from a market picture**: the same item in the same condition, postage-inclusive, with saturation and sold prices. Promotion only when it pays, below eBay's suggested rate. See [pricing-and-promotion.md](docs/pricing-and-promotion.md).

## Decisions (2026-11-03)

- **A learning pricing engine** replaces the fixed percentile rule: Claude identifies the item and checks every comparable, both sold-data providers are pooled, the market is classed (normal, race to the bottom, decline, thin), and the price maximises expected profit allowing for time to sell. It learns from listings that sell or sit. Bundles are priced as the sum of their parts, and weekly advice suggests combining or splitting listings. See [pricing-engine.md](docs/pricing-engine.md).
- **Never assume item facts**: look up specifications only for an exactly identified product, with sources; otherwise ask. Coach photos for someone new to selling. See [listing-assistant.md](docs/listing-assistant.md).
- **First-day audit** of listings, sold history, messages (reply style) and settings once the real account connects.
- **UI redesign** with the tasteskill: eBay-based colours made K's own, a logo, separate phone and desktop layouts with the same features.

## Decisions (2026-11-05)

- **Dashboard redesign** ([design-system.md](docs/design-system.md)): glass and glow, swipeable approval cards, a listings catalogue, Insights and Store Pulse (was Audit), and a New listing wizard, now on the drafts server (merged 2026-11-06). The environment shows as a pinned pill; the change switch, Claude spend and diagnostics are under Settings → Advanced. This supersedes the tasteskill rules for the app.

## Decisions (2026-11-07)

- **Sign-in** (K): email plus a 6-digit authenticator-app code (Google or Microsoft Authenticator), replacing passkeys, invites and recovery codes. The people (K now, managers later) are set only by K with `scripts/people.mjs`, kept in Key Vault (`PEOPLE`). The site is hidden: a blank 404 for anyone not signed in, with the sign-in page at a secret address (`SIGNIN_PATH`). See [security.md](docs/security.md). Never print `PEOPLE` or run `people.mjs` for K: it shows authenticator secrets.

## Decisions (2026-11-06)

- **One Sell screen**: the redesign's New listing wizard, on the real drafts server; `add-listing` and `claude/frontend-redesign` merged on `merge-redesign` ([handover](docs/add-listing-handover.md)). One set of photo checks (`web/src/photocheck.ts`).
- **Claude may deploy to Sandbox** (`node scripts/azure-deploy.mjs sandbox`) and run `scripts/sandbox-listing-check.mjs` there. Production stays K's.
- **Postage** (K, 2026-11-06): the app works out the packed parcel and the Simple Delivery size from eBay's list, fills in postage from Parcel2Go, and after publishing files a to-do for K to switch the listing to Simple Delivery in Seller Hub (the API can't). Parcels too big for it, or items over £750, go by courier at a Parcel2Go quote.
- **Parcel2Go** is on trial for postage quotes ([parcel2go-api.md](docs/parcel2go-api.md), `scripts/parcel2go-quote.mjs`); kept only if its sandbox replies are good.

## Rules that are enforced in code, never in prompts

These are in `src/rules.ts`. K confirmed the selling rules on 2026-10-12 and the approval rules on 2026-11-02.

- **Every eBay write needs approval.** Anything that changes the eBay account goes through a proposal (`src/proposals.ts`). It changes eBay only after K approves it from a push notification or the dashboard Inbox. Signed links work by POST only. Never add a tool or code path that writes to eBay directly.
- **Locked kinds.** `price`, `message`, `best_offer_response`, `offer_to_watchers`, `create_listing`, `end_listing`, `policy` and `promote` can never be auto-applied, whatever the dashboard settings say.
- **One write gate.** Only `ebayWrite()` in `src/ebay/write.ts` may call eBay write endpoints. It refuses unless `WRITE_MODE=approval`, the kill switch is off and the proposal is approved. Every write is recorded in `audit_log`.
- **Read-only until Phase 8.** K's real account is connected read-only (Phase 6). Never set `WRITE_MODE=approval` in production, or request write scopes, before Phase 8 and the go-live tests.
- **Pricing target (K's seller rule, 2026-11-06).** The pricing engine (`src/pricing/`, [pricing-engine.md](docs/pricing-engine.md)) prices like K: what buyers pay comes from sales in the same condition only (close or different-condition matches only when there's nothing else; with under 6 sales, their middle, no trend). With realistic competition it goes just under the cheapest same-condition listing; listings far above what buyers pay (over 1.3x the value, or 15% above the dearest sale) are ignored; it never goes below the lowest same-condition sale to chase a cheap listing. With no realistic competition it prices at what buyers pay. Temporary dips, falling markets and faults keep their own rules. K's floor is enforced in code; the engine moves at most 10% a step, and a bigger jump or a second change within 7 days is flagged on the label.
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
| `src/store/`, `infra/cosmos-containers.json` | The data store: one document layer with a Cosmos DB and an in-memory implementation, repositories on top, and the 14 containers |
| `src/platform/azure/`, `infra/`, `scripts/azure-*.mjs` | The Azure Functions adapter (HTTP, timers, queue), Bicep templates, and the infra, secrets and deploy scripts |
| `test/` | Vitest: gate refusal paths (`gate.test.ts`), source scans keeping writes behind the gate (`safety.test.ts`) |
| `docs/` | Design docs and roadmap |
| `src/api.ts`, `src/session.ts` | Dashboard JSON API and K's sign-in session |
| `src/auth/`, `src/signin.ts`, `scripts/people.mjs` | Sign-in: the people list from Key Vault (`people.ts`), authenticator codes (`totp.ts`), sessions and the known-device mark (`users.ts`), the hidden sign-in page, and K's script that sets the people |
| `web/` | The dashboard PWA (Preact, Tailwind, Framer Motion). `MOCK=1 npm run dev:web` runs it on sample data. `ui.tsx` shared motion pieces, `wizard.tsx` + `camera.tsx` + `photocheck.ts` (the one set of photo checks) the New listing flow. Under `MOCK=1`, `/api/drafts` runs the real server code with stand-ins for Claude, eBay and sold data (`web/mock-drafts.ts`) |
| `scripts/` | `make-keys.mjs` (DASHBOARD_KEY, VAPID_KEY into .dev.vars), `make-icons.mjs` |
| `src/claude.ts`, `src/jobs.ts` | Claude tool-use loop (allowlisted tools, cost log, daily budget) and the jobs that use it |
| `src/nightly.ts`, `src/health.ts`, `src/ebay/sell.ts` | The 02:00 run: snapshot, orders and traffic sync, rule-based health flags, Haiku triage of flagged listings |
| `src/pricing/` | The pricing engine: `model.ts` (maths, pure), `identify.ts` (Claude identify and match), `engine.ts`, `learn.ts`, `bundles.ts` |
| `src/solddata.ts`, `src/solddata-eval.ts`, `src/salesreport.ts` | Trawl and CompsAPI sold data (capped, cached), K's comparison test, the Seller Hub orders report import |
| `src/specs.ts` | Published specifications for an exactly identified product (Sonnet + web search), each with a verified source |
| `src/firstday.ts`, `src/style.ts`, `src/promotion.ts`, `src/ebay/history.ts` | First-day audit report, K's reply style guide, Promoted Listings research, and the account-history reads they use |
| `src/inbox.ts`, `src/ebay/inbox.ts` | The 15-minute poll: buyer questions and Best Offers, Haiku drafts, floor enforced in code |
| `src/todos.ts`, `src/store/todos.ts`, `web/src/todos.tsx` | Inbox to-dos: what needs K but isn't an eBay change, filed by the audit and the nightly ([approvals.md](docs/approvals.md)) |
| `src/drafts.ts`, `src/newlisting.ts`, `src/photos.ts`, `src/postage.ts`, `src/store/drafts.ts`, `web/src/wizard.tsx`, `web/src/listing/` | Add Listing: the wizard at `/new` (`/sell` still opens it), drafts, private photos, Claude's photo check, sourced listing text, price, postage, submit as a `create_listing` label ([add-listing.md](docs/add-listing.md), [handover](docs/add-listing-handover.md)) |

## Commands

```sh
npm install
npm run typecheck && npm test   # tsc + vitest
MOCK=1 npm run dev:web          # the dashboard on sample data
node scripts/azure-deploy.mjs sandbox      # Claude may run this (typecheck and tests first)
$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-deploy.mjs production   # K runs this, then: node scripts/check-production.mjs
```

Production is read-only (`WRITE_MODE=off`, forced by the Bicep template). Claude can read production data for diagnosis (`node scripts/prod-query.mjs production <container> "SELECT ..."`: K's Azure login, which has only Data Reader on production), but K runs anything that changes production: infrastructure (`scripts/azure-infra.mjs`), deploys (`scripts/azure-deploy.mjs`) and secrets (`scripts/azure-secrets.mjs` from `.prod.vars`). Every production script refuses to run without `EBAY_CONFIRM_PRODUCTION=yes`. Never print secrets or `.prod.vars`.

## Where things stand (2026-11-06)

- Phases 0–6 are done, and the move to Azure is complete (M0–M8; Cloudflare deleted 2026-11-07). K's real eBay account is connected **read-only** to production: https://ebay-autopilot-production-wrpoyt.azurewebsites.net (Sandbox: https://ebay-autopilot-sandbox-wrpoyt.azurewebsites.net). K is the only user for now.
- **Branches:** `merge-redesign` holds everything (Azure work, Add Listing, the redesigned app) and runs on Sandbox. It goes to `azure-migration` (a fast-forward), then `main` by pull request, then production. Production still runs older `azure-migration` code.
- The pricing engine (`src/pricing/`, [pricing-engine.md](docs/pricing-engine.md)) follows K's seller rule (revision 4): same-condition sales set the value, just under the cheapest realistic listing, overpriced listings ignored. It prices listings, Best Offers and counters, audits and a nightly price review.
- K's past sales (23, from 2025-03 to 2026-09) are imported from the Seller Hub orders report. eBay's APIs return only 90 days.
- Add Listing is built and tested on Sandbox with K's own items ([add-listing-handover.md](docs/add-listing-handover.md)): condition first, Claude's photo check and research (model, specs, other names), listing text, price, postage done for K (parcel worked out, Simple Delivery size, Parcel2Go quotes) and a Seller Hub to-do after publishing. eBay Sandbox's picture service is down, so photo upload is first proven on production.
- **Current phase: 7, read-only on the real account.** Next: the steps in [add-listing-handover.md](docs/add-listing-handover.md#steps-left-before-going-live-updated-end-of-2026-11-06): code to `main`, production update, go-live tests C to H, then go live (section I).

## Open items

- Sold-price data: Marketplace Insights isn't available. Prices come from Trawl and CompsAPI, pooled, with hard monthly caps (Trawl 250, CompsAPI 100) and a 30-day cache ([sold-price-data.md](docs/sold-price-data.md)). Never scrape eBay or automate its website.
- The engine assumes 0% eBay final value fees (a UK private seller). Add a fee setting if K sells as a business.
- No CI is set up yet.
