# Roadmap

Everything up to Phase 5 runs on eBay Sandbox. K's real account is connected **read-only** in Phase 6, once the access controls in [security.md](security.md) are built. It accepts approved changes in Phase 8, after one nightly read-only cycle and the [go-live tests](go-live-tests.md). At launch **every** change needs approval: titles, descriptions, item specifics, prices, offers, replies and promotion.

Updated 2026-11-02 (plan v3). Design: [security.md](security.md), [pricing-and-promotion.md](pricing-and-promotion.md), [listing-assistant.md](listing-assistant.md), [go-live-tests.md](go-live-tests.md), [safety-and-environments.md](safety-and-environments.md), [approvals.md](approvals.md), [app-and-dashboard.md](app-and-dashboard.md).

**Current phase: 6. Production preparation.**

| # | Phase | Environment | Exit gate |
| --- | --- | --- | --- |
| 0–5 | Skeleton, safety, app, Claude, metrics, messages and offers (done) | Sandbox | Offer round trip passed 2026-11-02 |
| 6 | **Production preparation**: passkey sign-in for 3 people, roles, eBay call allowlist, hardening, account-deletion endpoint, production Worker with writes off | Sandbox, then production (read-only) | Security tests (go-live tests A, B) pass on Sandbox; K connects the real account read-only |
| 7 | **Read-only on the real account**: first-day audit, reply style guide, market pictures and pricing engine, promotion research, the redesigned app | Production read-only | One nightly cycle with everything running; go-live tests A to H pass |
| 8 | **Go live, approve everything** | Production | Go-live tests I1 to I5 |
| 9 | Auto-apply settings for listing edits (title, description, specifics), each with a "Done" notification | Production | K switches one on |
| 10 | Listing assistant: photos with coaching, no-assumption facts, publish | Production | First listing published via an approved proposal |
| later | Optional third-party sold data (off by default, see sold-price-data.md), Cloudflare Access in front | Production | — |

## Phase 1: Safety foundation (sandbox)

- [x] `ebayHosts(env)` helper; remove hard-coded production hosts from `src/ebay/auth.ts`, `trading.ts` and `browse.ts`.
- [x] Wrangler environments `sandbox` and `production`, each with its own D1, R2, keyset secrets, `EBAY_ENV` and `WRITE_MODE`.
- [x] `src/ebay/write.ts` with `ebayWrite()`, the only path to eBay write calls. Move `revisePrice` behind it.
- [x] D1: `audit_log`, `settings` (kill switch), and `expires_at` and `dry_run` columns on `proposals`.
- [x] `LOCKED_KINDS` and `PROPOSAL_TTL_DAYS` in `src/rules.ts`; replace `PRICE_CHANGES_NEED_APPROVAL` and `MESSAGES_NEED_APPROVAL` with "all writes need approval".
- [x] Signed links include expiry.
- [x] Proposal kinds and apply paths for `revise` and `create_listing` (needed to make sandbox test listings).
- [x] Tests: every gate refusal path, and the source scan for write calls outside `write.ts`.
- [x] Trading client refuses any verb outside a read allowlist (second code guard beside the write gate).
- [x] Deploy `--env sandbox`, sign in with a sandbox test user, create 3–5 test listings via approved proposals (3 created; new listings are checked with `VerifyAddFixedPriceItem` before K is asked).
- [x] Confirmed on Sandbox that read-only scopes don't stop Trading API writes: sign in with `/oauth/start?readonly=1`, approve a price change on a test listing. Result: the price changed, as eBay's docs say; recorded in safety-and-environments.md.

## Phase 2: App shell (sandbox)

- [x] `web/` Vite + Preact app served by Workers static assets. Sign-in with `DASHBOARD_KEY` and a signed session cookie instead of Cloudflare Access, which needs K in the Cloudflare dashboard; Access can be added in front later.
- [x] `src/api.ts`: proposals list, decide (single and batch), listings, settings, push subscribe.
- [x] Inbox, Listings, Activity and Settings screens; environment banner.
- [x] Manifest and service worker; Web Push with VAPID; `push_subscriptions` table; test push; notification actions that POST the decision.
- [x] `src/notify.ts` sends Web Push first, ntfy as a fallback if configured.
- [ ] K installs the app on Android, turns on notifications in Settings, and approves a Sandbox change from a notification (the exit gate).

## Phase 3: Claude (sandbox)

- [x] `src/claude.ts`: manual tool-use loop over an allowlist of `src/tools.ts` with `claude-sonnet-5-5` (effort medium, cached system prompt, server-side refusal fallbacks), a turn limit and a daily budget (`CLAUDE_DAILY_BUDGET_USD`).
- [ ] K adds `ANTHROPIC_API_KEY` as a Worker secret (`npx wrangler secret put ANTHROPIC_API_KEY --env sandbox`), then runs a first review.
- [x] Listing audit (`src/jobs.ts`): per listing, Claude proposes one revision (title, specifics, description) and a price change if comps support it. Ad rates wait until Promoted Listings tools exist. Triggered by **Review with Claude** on each listing.
- [x] Batch review in the Inbox (Phase 2).
- [x] `claude_usage` table logged on every call; spend shown in Settings.

## Phase 4: Metrics and nightly health (sandbox)

- [x] Nightly sync of orders (Fulfillment API) and traffic (Analytics API), read-only. Sandbox returns no traffic data, so that step fails there and the rest carry on.
- [x] Rule-based health flags per listing (`src/health.ts`), no Claude: no watchers after 30 days, watched but not selling, few views, seen but not opened.
- [x] Only flagged listings (at most 5 a night) go to `claude-haiku-5-5` for triage; any change is a proposal.
- [x] Metrics screen: 30-day figures, single-series charts (dataviz rules, validated `#008aa3`), nightly check status and flags, Claude spend against the daily budget.
- [ ] Listing detail screen (price and watcher history per item). Deferred: the Listings screen covers the essentials for now.

## Phase 5: Buyer messages and offers (sandbox)

- [x] Poll every 15 minutes for unanswered buyer questions (`GetMemberMessages`) and active Best Offers (`GetBestOffers`). Polling is read-only; eBay push notifications would need `SetNotificationPreferences`, a change to the account.
- [x] Haiku drafts a reply from the listing's own details, or suggests accept, counter or decline for an offer (structured output). K's floor is enforced in code. Without a key, replies wait for K and offers get a plain suggestion.
- [x] Each becomes a proposal with a push; K can edit the reply or the offer answer in the Inbox, then approve. The write gate sends `AddMemberMessageRTQ` or `RespondToBestOffer`.
- [x] Offer round trip on 2026-11-02: test buyer offered £9 (via `scripts/sandbox-buyer.mjs`, since the Sandbox website fails on buyer pages), Claude suggested an answer, K edited it to a £11 counter and approved from the app, and the buyer saw the counter.
- [ ] Question round trip: not testable on Sandbox (its message pages fail and there is no buyer API for pre-sale questions). Checked in Phase 6 instead, where real questions produce dry-run drafts that can't be sent.

## Phase 6: Production preparation

- [x] Passkey (WebAuthn) sign-in per person, recovery codes, server-side sessions (12 h idle, 7 days max), sign out everywhere ([security.md](security.md)).
- [x] Users: owner plus at most 2 managers, single-use 24-hour invite links, roles enforced on every route; who did what recorded on proposals and in Activity.
- [x] Production decide links need the signed link **and** the device's session; replies and offer acceptances can require opening the app (on by default in production).
- [x] `src/ebay/allowlist.ts`: every eBay call checked against the list in security.md, with a test.
- [x] `/mcp` off in production; `/oauth/start` needs the owner's session; sign-in rate limits.
- [x] Marketplace account deletion endpoint: answers eBay's challenge, verifies signed notifications, deletes that buyer's stored data.
- [x] Production Worker deployed with `WRITE_MODE=off`, its own D1 and R2, and production secrets in K's gitignored `.prod.vars`: https://ebay-autopilot-production.ebay-autopilot.workers.dev. `node scripts/check-production.mjs` runs the remote go-live checks (17 passing on 2026-11-02).
- [x] App redesigned (tasteskill "The page is the object": each change is a parcel label with a tear-off stub; eBay colours as the four states; Rokkitt and Literata self-hosted; phone and desktop layouts).
- [ ] K: activate the production keyset (endpoint and verification token entered in the portal), create the production RuName. (Marketplace Insights isn't available to this app: see [sold-price-data.md](sold-price-data.md).)
- [ ] K connects the real account read-only.

## Phase 7: Read-only on the real account

- [ ] First-day audit and report: listings, sold history, ended listings, messages, settings ([listing-assistant.md](listing-assistant.md)).
- [ ] Reply style guide from K's past replies, used by every draft.
- [ ] Market pictures and the pricing engine for prices, offers and counters ([pricing-and-promotion.md](pricing-and-promotion.md)), with sold prices estimated from sanctioned sources and a Terapeak check step ([sold-price-data.md](sold-price-data.md)).
- [ ] Promotion research: propose only when the market is saturated and the rate pays back, below eBay's suggestion.
- [ ] The redesigned app (tasteskill; eBay-based colours made K's own, logo, separate phone and desktop layouts, same features).
- [ ] One full nightly cycle with all of it, then go-live tests A to H.

## Phase 8: Go live

- [ ] Go-live tests I1 to I5: re-sign in with full permissions, `WRITE_MODE=approval`, first change small and reversible, the first 10 one at a time.

## Phase 9: Auto-apply settings

- [ ] Settings (owner only): separate switches for title, description and item specifics changes. When on, those apply without a tap and a "Done" notification says exactly what changed, with an undo proposal one tap away.
- [ ] Prices, offers, counters, replies, new listings, ending listings, promotion and policies stay approval-only, enforced in code (`LOCKED_KINDS`).

## Phase 10: Listing assistant

- [ ] Photo screen with the checklist and per-photo feedback (light, background, framing, focus, required shots).
- [ ] Facts: exact product, then cited specifications; otherwise ask K. Condition always from K.
- [ ] Market-picture price, suggested postage, eBay's check, approval, publish (Inventory and Media APIs; photos in R2).
