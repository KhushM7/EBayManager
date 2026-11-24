# EBayManager

Automates K's eBay selling: improve existing listings, re-evaluate unsold ones, build new listings from photos, and draft buyer replies. K approves every change to the eBay account: every price, revision, ad rate, listing and buyer message.

Full plan (decisions, eBay API map, rollout): https://claude.ai/artifact/JowUE86DsPhFBsswMms8jf

Design docs: [roadmap](docs/roadmap.md), [Power Platform](docs/power-platform.md), [design system](docs/design-system.md), [pricing engine](docs/pricing-engine.md), [security](docs/security.md), [pricing and promotion](docs/pricing-and-promotion.md), [sold-price data](docs/sold-price-data.md), [listing assistant](docs/listing-assistant.md), [go-live tests](docs/go-live-tests.md), [safety and environments](docs/safety-and-environments.md), [approvals](docs/approvals.md), [app and dashboard](docs/app-and-dashboard.md), [photo AI](docs/imageai.md).

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

- **Dashboard redesign** ([design-system.md](docs/design-system.md)): glass and glow, swipeable approval cards, a listings catalogue, Insights and Store Pulse (was Audit), and a New listing wizard, now on the drafts server (merged 2026-11-06). The environment shows as a pinned pill. This supersedes the tasteskill rules for the app.

## Decisions (2026-11-07, Settings)

- **Settings is organised** (K): the Changes to eBay switch (Pause all changes) leads the page; then Account, Notifications, eBay connection, Reply style, and Usage and APIs (Claude and sold-data allowances, Claude spend). On a phone each section is its own page; on a desktop the menu sits beside it. The sold-price provider comparison and the diagnostics (test notification) were development tools and are removed.

## Decisions (2026-11-13, photo AI)

- **AI photo tools, self-hosted** (K): eBay itself offers AI background removal, so the editor may remove the background (IS-Net, rembg's model), spot-remove clutter around the item (LaMa) and upscale for quality (Real-ESRGAN). Nothing on the item itself may be removed or hidden, and the original is always kept ([add-listing.md](docs/add-listing.md), decision 4). They run in K's own container on Azure Container Apps, scaled to zero, so they cost nothing unless used ([imageai.md](docs/imageai.md)). No paid image API.

## Decisions (2026-11-07)

- **Sign-in** (K): email plus a 6-digit authenticator-app code (Google or Microsoft Authenticator), replacing passkeys, invites and recovery codes. The people (K now, managers later) are set only by K with `scripts/people.mjs`, kept in Key Vault (`PEOPLE`). The site is hidden: a blank 404 for anyone not signed in, with the sign-in page at a secret address (`SIGNIN_PATH`). See [security.md](docs/security.md). Never print `PEOPLE` or run `people.mjs` for K: it shows authenticator secrets.

## Decisions (2026-11-06)

- **One Sell screen**: the redesign's New listing wizard, on the real drafts server; `add-listing` and `claude/frontend-redesign` merged on `merge-redesign` ([handover](docs/add-listing-handover.md)). One set of photo checks (`web/src/photocheck.ts`).
- **Claude may deploy to Sandbox** (`node scripts/azure-deploy.mjs sandbox`) and run `scripts/sandbox-listing-check.mjs` there. Production stays K's.
- **Postage** (K, 2026-11-06): the app works out the packed parcel and the Simple Delivery size from eBay's list, fills in postage from Parcel2Go, and after publishing files a to-do for K to switch the listing to Simple Delivery in Seller Hub (the API can't). Parcels too big for it, or items over £750, go by courier at a Parcel2Go quote.
- **Parcel2Go** is on trial for postage quotes ([parcel2go-api.md](docs/parcel2go-api.md), `scripts/parcel2go-quote.mjs`); kept only if its sandbox replies are good.

## Decisions (2026-11-15)

- **Pricing** (K, [pricing-engine.md](docs/pricing-engine.md), revision 5): live listings first, then sales. One floor; the options always ascend; the reason is written for the price chosen, in item prices (postage is the next step, and isn't shown here). With nothing in the same condition, other-condition comparables are adjusted to the item (new against used: 0.5 to 0.9 by its wear) and the result says so. The price step shows what was found (how many, cheapest, middle, dearest) and where each price sits, in place of days to sell, and whoever lists the item may set their own price.
- **Listing style** (K, `src/guidance.ts`): the owner, never a manager, tells Claude in the app how listings should be written; each piece of feedback becomes a standing rule (wording, or a fact true of every item) for new listings and Claude's rewrites. Rules sit below the fixed ones; links and contact details are refused.
- **Promotion** (K): proposed when a listing isn't being seen (few impressions, or hardly any views and nobody watching after 14 days), not for days listed alone. Approved `promote` labels now apply (2% to 4%).
- **Offers to watchers** (K, `src/watchers.ts`): a reminder, so as little off as eBay allows: always 5% for 2 days (eBay's own minimum and length, K's maximum; 2% was never possible), never under the floor. Proposed nightly, approved by K, sent by the gate.
- **The sales ladder** (K, `src/ladder.ts`): a listing that isn't selling gets one push at a time, at most one a week, chosen by its own figures: unseen, the title and specifics first, then promotion; watched but unsold, an offer to watchers, then the price; seen but unwatched, the price. The nightly's price review, triage, watcher offers and promotion each act only on their rung (a price change of 10% or more still goes ahead: the market moved).
- **The 14-day promotion review** (K, `src/promotion.ts`): two weeks after an ad is applied, and every two weeks after, the listing's views, impressions and watchers are compared with before; if no more people see it, an "end" label is filed. A promoted listing is no longer ended just for being seen.
- **eBay refusals are never silent** (K, `reportWriteFailure` in `src/proposals.ts`): when eBay refuses or fails an approved change, an Inbox to-do says so and carries the raw diagnostics (every call sent for the label, what was sent, eBay's status, request id and whole reply) with a Copy button, and a notification points to it. It resolves when the same kind of change next goes through for that listing.
- **Microsoft Power Platform** (K's plan, [power-platform.md](docs/power-platform.md)): Power BI, Power Automate, Power Apps and Copilot Studio may only read EBayManager's data, through a read-only API with its own key (`/api/ro/*`, `RO_API_KEY`), or show a person a proposal; they never hold eBay tokens, call eBay or decide anything. The Stock Room app may send items as new-listing drafts only (`/api/intake/drafts`, `INTAKE_API_KEY`). No buyer personal data leaves. Both APIs are off until K sets their key. The app's side is built and tested; the tenant's side (`powerplatform/`) is recipes K hasn't built yet, so none of it is claimed anywhere.
- **Git in Claude sessions** (K): commits are authored as K with GitHub's private address (`Khush Mehta <124626664+KhushM7@users.noreply.github.com>`, never a personal email: the repository is public), unsigned, with no co-author or session lines and no mention of Claude as author. New branches have plain names: no `claude/` prefix, no random letters at the end.
- **Deploying from GitHub** (K): `.github/workflows/deploy.yml`, started by hand or by Claude. Sandbox deploys at once; production waits for K's approval in GitHub and deploys only from `main` (README, "Deploying from GitHub").

## Decisions (2026-11-24, finishing)

- **Nothing that costs to run** (K; Claude excepted, see below). The Power Automate digest and nudge flows are turned off. Copilot Studio stays unpublished (no credits). Power Platform stays read-only and off in production (no keys).
- **Showcase** (K): `docs/showcase/` holds a page, a PDF carousel, a short video and screenshots for K's CV and LinkedIn, on sample data and Sandbox only (`scripts/showcase-build.mjs`). Never put real account, buyer or production data in it.

## Decisions (2026-11-24, production fixes)

- **Plan**: [production-fixes-plan.md](docs/production-fixes-plan.md). Claude stays **on** in production (K, reversing that morning's switch-off, which never took effect: `azureEnv()` didn't pass the setting on). Run the infrastructure before deploying this code.
- **Every offer is shown** (K), full-price ones included, and nothing is auto-declined or auto-accepted. No pay-per-click or offsite ads.
- **Bundle assistant** (`src/bundles.ts`): one group of related listings at a time in eBay's own bundle discounts, rotated, reviewed nightly. eBay has no API found for it, so it's a guide K follows; it never writes.
- **Inbox is To decide and History** (`src/history.ts`, `src/store/events.ts`): every suggestion's outcome is kept, append-only.
- **Logs** (`src/log.ts`, `src/redact.ts`, `src/monitor.ts`, `scripts/logs.mjs`): never a bare `.catch(() => null)`; use `swallow()`. Azure caps 0.1 GB (production) and 0.05 GB (Sandbox) a day.
- **Buyer fee** (K): K sets a base price and receives it; eBay adds the fee for buyers (`src/buyerfee.ts`). eBay's API reports K's figure for listings and offers (proven on five offers, 2026-11-24), so a buyer's round £25 arrives as 23.37.

## Rules that are enforced in code, never in prompts

These are in `src/rules.ts`. K confirmed the selling rules on 2026-10-12 and the approval rules on 2026-11-02.

- **Every eBay write needs approval.** Anything that changes the eBay account goes through a proposal (`src/proposals.ts`). It changes eBay only after K approves it from a push notification or the dashboard Inbox. Signed links work by POST only. Never add a tool or code path that writes to eBay directly.
- **Locked kinds.** `price`, `message`, `best_offer_response`, `offer_to_watchers`, `create_listing`, `end_listing`, `policy` and `promote` can never be auto-applied, whatever the dashboard settings say.
- **One write gate.** Only `ebayWrite()` in `src/ebay/write.ts` may call eBay write endpoints. It refuses unless `WRITE_MODE=approval`, the kill switch is off and the proposal is approved. Every write is recorded in `audit_log`.
- **Approval mode from Phase 8 (go-live, 2026-11-07).** The go-live tests passed (K) and production runs `WRITE_MODE=approval`: eBay writes happen only through `ebayWrite()` after a person approves the proposal. To go back to read-only, K sets `writeMode = 'off'` in `infra/production.bicepparam` and runs the infrastructure update.
- **Pricing target (K's seller rule, 2026-11-06).** The pricing engine (`src/pricing/`, [pricing-engine.md](docs/pricing-engine.md)) prices like K: what buyers pay comes from sales in the same condition only (close or different-condition matches only when there's nothing else; with under 6 sales, their middle, no trend). With realistic competition it goes just under the cheapest same-condition listing; listings far above what buyers pay (over 1.3x the value, or 15% above the dearest sale) are ignored; it never goes below the lowest same-condition sale to chase a cheap listing. With no realistic competition it prices at what buyers pay. Temporary dips, falling markets and faults keep their own rules. K's floor is enforced in code; the engine moves at most 10% a step, and a bigger jump or a second change within 7 days is flagged on the label.
- **Returns.** Always accepted, and the buyer pays return postage. This is set as an eBay business policy.
- **Shipping** (K, 2026-11-07). Assume K has a box and ships the item, and offer collection in person as well by default (`DEFAULT_SHIPPING` in `src/rules.ts`); K can turn collection off for an item, or make it collection only.
- **Live listings every time** (K, 2026-11-07). Every price check (manual, nightly, Claude's reviews and triage, Best Offer answers) searches eBay's live listings afresh: what the item sells for now is the main benchmark. Only sold data (30-day cache) and title grades are reused. A stored result stands in only if the fresh check fails.
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
| `src/solddata.ts`, `src/salesreport.ts` | Trawl and CompsAPI sold data (capped, cached), the Seller Hub orders report import |
| `src/allowance.ts` | What's left of Claude credit (K enters the Console balance; the app subtracts its logged spend) and the sold-data monthly searches (as Trawl and CompsAPI themselves report them: headers on every reply, and their free `/health` and `/v1/usage` calls; the app's own count only if they can't be reached). Each provider can have a second key (`TRAWL_API_KEY_2`, `COMPSAPI_KEY_2`) that takes over when the first is used up; the sold-data alert opens only when the first key is used up and the second is below 10% (one key: below 10%); low or out opens an Inbox to-do with a notification (15-minute poll and nightly). Shown in Settings → Usage and APIs |
| `imageai/`, `infra/modules/imageai.bicep`, `.github/workflows/imageai.yml` | The photo AI container ([imageai.md](docs/imageai.md)): FastAPI and onnxruntime CPU with IS-Net (background removal), LaMa (spot removal) and Real-ESRGAN (upscale), models pinned by SHA-256. It's built by GitHub Actions to a public ghcr.io image and runs on Container Apps Consumption at 0–1 replicas. It's deployed only when `IMAGEAI_IMAGE` names a tag at infrastructure time, and `imageai/test-local.mjs` tries it locally |
| `src/imageai.ts` | `/api/photo-ai/{remove_background,erase,upscale}`: checks the upload (JPEG or PNG, at most 12 MB and 2400 px, mask the same size), strips metadata, and forwards it with `IMAGEAI_KEY` to `IMAGEAI_URL` (180 s timeout for a cold start). Recorded as the `imageai` service |
| `src/services.ts` | Whether each outside service works: eBay sign-in (a revoked refresh token after a username or password change), eBay, Claude, Trawl, CompsAPI, Parcel2Go, Photo AI. Each call records its outcome at its choke point (`watched()`, the token request, `createMessage()`); a rejected key or sign-in alerts at once, other faults after 3 in a row over 10 minutes. The 15-minute poll and the nightly run file an Inbox to-do with a notification and resolve it when the service works again. Settings shows Reconnect eBay and the status of each service |
| `src/ebay/pictures.ts` | Listing pictures for the Listings page, fetched from eBay's picture hosts only and served by the app (`/api/listings/:id/image`), so the CSP stays `'self'` |
| `src/util.ts` | Small shared helpers (`r2`, `list`, `num`, `stripHtml`) |
| `src/specs.ts` | Published specifications for an exactly identified product (Sonnet + web search), each with a verified source |
| `src/firstday.ts`, `src/style.ts`, `src/promotion.ts`, `src/ebay/history.ts` | First-day audit report, K's reply style guide, Promoted Listings research, and the account-history reads they use |
| `src/inbox.ts`, `src/ebay/inbox.ts` | The 5-minute poll (service checks every 15): every Best Offer including full-price ones, buyer questions, sales; Haiku drafts, floor enforced in code. `src/sales.ts`, `src/offersapi.ts`, `src/ebay/messages.ts` (Message API: reads proven on production, sending not yet) go with it. The Messages screen is `web/src/messages.tsx`, with `quoted.ts` for what's shown of a message |
| `src/guidance.ts`, `web/src/rules.tsx` | K's standing rules for how Claude writes listings: feedback to a rule (Haiku), kept in the store, added to the compose and review prompts. Owner only (`/api/listing-rules`) |
| `src/ladder.ts` | The sales ladder: each listing's one step tonight (listing, price, offer, promote, wait), read by the nightly steps |
| `src/watchers.ts` | Offers to watchers: the nightly step that proposes a 5% reminder offer for listings eBay says are eligible |
| `.github/workflows/deploy.yml`, `scripts/azure-github-oidc.mjs` | Deploying from GitHub with K's approval for production, and its one-time Azure set-up |
| `src/ro/`, `src/links.ts`, `src/mcp-core.ts` | The read-only API for Power Platform ([power-platform.md](docs/power-platform.md)): `tables.ts` (what may leave: no buyer details, allowlisted proposal fields), `handler.ts` (the key, the limits, the GET routes and the read-only MCP tools), `digest.ts` (the weekly digest in words), `export.ts` (the nightly CSV files for Power BI). It imports nothing that writes; `test/readonly.test.ts` follows its imports. `links.ts` is the approval-link signing; `mcp-core.ts` the small MCP server both `/mcp` and `/api/ro/mcp` use |
| `scripts/check-power-platform.mjs` | Checks the two Power Platform APIs on a deployed environment: hidden without a key; with the read-only key, reads only |
| `docs/showcase/`, `scripts/showcase-build.mjs` | The portfolio showcase: page, slides, screenshots (sample data and Sandbox only), and the script that builds the single-file page, the PDF and the video |
| `src/intake.ts` | Stock Room intake: `POST /api/intake/drafts` with its own key makes a new-listing draft (one per row, 30 a day) and nothing else |
| `powerplatform/` | What K builds in the Microsoft tenant: the two custom connectors (OpenAPI 2.0), the Power BI model (`powerbi/build.mjs` writes the Power Query, DAX and TMDL), and recipes for the flows, the Stock Room app and the Copilot Studio agent. None of it has been opened in a Microsoft tool yet |
| `src/todos.ts`, `src/store/todos.ts`, `web/src/todos.tsx` | Inbox to-dos: what needs K but isn't an eBay change, filed by the audit and the nightly ([approvals.md](docs/approvals.md)) |
| `src/drafts.ts`, `src/newlisting.ts`, `src/photos.ts`, `src/postage.ts`, `src/store/drafts.ts`, `web/src/wizard.tsx`, `web/src/listing/` | Add Listing: the wizard at `/new` (`/sell` still opens it), drafts, private photos, Claude's photo check, sourced listing text, price, postage, submit as a `create_listing` label ([add-listing.md](docs/add-listing.md), [handover](docs/add-listing-handover.md)) |

## Commands

```sh
npm install
npm run typecheck && npm test   # tsc + vitest
MOCK=1 npm run dev:web          # the dashboard on sample data
node scripts/azure-deploy.mjs sandbox      # Claude may run this (typecheck and tests first), or start the deploy workflow for sandbox
$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-deploy.mjs production   # K runs this, then: node scripts/check-production.mjs
```

Production runs in approval mode (`WRITE_MODE=approval`, set in `infra/production.bicepparam`) since go-live on 2026-11-07. Claude can read production data for diagnosis (`node scripts/prod-query.mjs production <container> "SELECT ..."`: K's Azure login, which has only Data Reader on production), but K runs anything that changes production: infrastructure (`scripts/azure-infra.mjs`), deploys (`scripts/azure-deploy.mjs`) and secrets (`scripts/azure-secrets.mjs` from `.prod.vars`). Every production script refuses to run without `EBAY_CONFIRM_PRODUCTION=yes`. Never print secrets or `.prod.vars`.

## Where things stand (2026-11-07)

- Phases 0–6 are done, and the move to Azure is complete (M0–M8; Cloudflare deleted 2026-11-07). K's real eBay account is connected to production (full permission granted at go-live, in approval mode): https://ebay-autopilot-production-wrpoyt.azurewebsites.net (Sandbox: https://ebay-autopilot-sandbox-wrpoyt.azurewebsites.net). K is the only user for now.
- **Branches:** `azure-migration` holds everything and is what runs on Sandbox and production. It goes to `main` by pull request.
- The pricing engine (`src/pricing/`, [pricing-engine.md](docs/pricing-engine.md)) follows K's seller rule (revision 4): same-condition sales set the value, just under the cheapest realistic listing, overpriced listings ignored. It prices listings, Best Offers and counters, audits and a nightly price review.
- K's past sales (23, from 2025-03 to 2026-09) are imported from the Seller Hub orders report. eBay's APIs return only 90 days.
- Add Listing is built and tested on Sandbox with K's own items ([add-listing-handover.md](docs/add-listing-handover.md)): condition first, Claude's photo check and research (model, specs, other names), listing text, price, postage done for K (parcel worked out, Simple Delivery size, Parcel2Go quotes) and a Seller Hub to-do after publishing. On production, photos go to eBay through the Media API (`createImageFromFile`; Trading's `UploadSiteHostedPictures` is retired there), proven with the first real listing on 2026-11-07. Photo tools: Adjust (rotate, crop, centre), Arrange (drag to reorder), Tidy background; drafts can be renamed and deleted, and a failed listing is sent again with one tap.
- **Current phase: 8, live in approval mode** (2026-11-07). Go-live tests A to H passed; I1 to I3 and I6 done (the first real listing is live). Left: the rest of the first 10 changes (I4) and one real Best Offer answer (I5); managers when they join (README, "Adding a manager"). Costs so far: Claude $1.39 on production in 5 days; Azure inside its free allowances (README, "Costs").

## Open items

- Sold-price data: Marketplace Insights isn't available. Prices come from Trawl and CompsAPI, pooled, with hard monthly caps (Trawl 250, CompsAPI 100) and a 30-day cache ([sold-price-data.md](docs/sold-price-data.md)). Never scrape eBay or automate its website.
- The engine assumes 0% eBay final value fees (a UK private seller). Add a fee setting if K sells as a business.
- Power Platform: the app's side is on the branch `power-platform`, unmerged; both APIs are on for Sandbox (2026-11-18) and off in production (no keys). K's steps and open questions are in [power-platform.md](docs/power-platform.md).
- No CI is set up yet (the deploy workflow runs typecheck and tests before publishing).
- Promoted Listings through the gate is proven on Sandbox (2026-11-15: campaign and ad created at 2%, rate changed to 3%, ad ended). Offers to watchers is not: eBay Sandbox answered `sendOfferToInterestedBuyers` with a 500 "Internal error" twice, for a listing with no watchers, so the call's shape is still unconfirmed. Its first real proof is one approved label on production; a refusal changes nothing on eBay. Sandbox labels for either can be filed by hand with `POST /api/sandbox/propose` (Sandbox only).
- The sale model's learning was fixed on 2026-11-15 (production had tau 0.351, alpha 3.165, both at the edge of the search): one observation per stretch a listing spends at a price, a fit at the edge keeps the prior, results are bounded. Still open: a competitor's listing gone from the search results is counted as sold (`src/pricing/learn.ts`).
- `azure-migration` is an old branch, 23 commits behind `main` with nothing of its own: everything is on `main`.
