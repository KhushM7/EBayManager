# Roadmap

The real eBay seller account is connected read-only at Phase 6 and starts accepting approved writes at Phase 7. Everything before that runs on eBay Sandbox. Each phase ends with a gate that must pass before the next starts.

Updated 2026-11-02. Design details: [safety-and-environments.md](safety-and-environments.md), [approvals.md](approvals.md), [app-and-dashboard.md](app-and-dashboard.md).

**Current phase: 6 needs K. Phases 1–5 are built and running on Sandbox.** The Phase 2 and 3 gates wait for K (install the app, add the Anthropic key).

| # | Phase | Environment | Exit gate |
| --- | --- | --- | --- |
| 0 | Skeleton (done, PR #1) | none | Merged |
| 1 | Safety foundation | Sandbox | No eBay write is possible without an approved proposal, proven by tests; sandbox sign-in works |
| 2 | App shell: dashboard, PWA, Web Push | Sandbox | K approves a sandbox price change from the Android notification |
| 3 | Claude: tool-use loop and listing audit | Sandbox (+ production Browse comps) | Audit of sandbox listings fills the Inbox with sensible proposals |
| 4 | Metrics and nightly health | Sandbox | Metrics screen renders; nightly run logs Claude spend |
| 5 | Buyer messages and offers | Sandbox (test buyer) | Message and Best Offer round trip with a sandbox buyer |
| 6 | **Connect real account, read-only** | Production read-only | Go-live checklist ticked |
| 7 | **Enable approved writes** | Production | First 10 approved writes verified on eBay |
| 8 | Listing from photos | Production | First listing published via an approved proposal |
| later | Opt-in auto-apply for eligible kinds | Production | K switches a kind on in Settings |

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
- [ ] Round trip with a second Sandbox user as the buyer: K registers a second test user, asks a question and makes an offer on a test listing, then approves the replies.

## Phase 6: Connect real account, read-only

- [ ] Production keyset active (opt out of marketplace account deletion notifications; the app stores no other users' data).
- [ ] Deploy `--env production` with `WRITE_MODE=off`; sign in with read-only scopes.
- [ ] Dry-run audit: proposals appear in the Inbox marked "dry run" with no Approve button.
- [ ] Run for at least 7 days; work through the [go-live checklist](safety-and-environments.md#go-live-checklist).

## Phase 7: Enable approved writes

- [ ] Re-sign in with full scopes; set `WRITE_MODE=approval`.
- [ ] Approve the first writes one at a time and check each on eBay.

## Phase 8: Listing from photos

- [ ] Upload photos from the PWA to R2; Sonnet gives photo-quality feedback and drafts the listing.
- [ ] `create_listing` proposal; publish via the Inventory API on approval.

## Later: auto-apply

- [ ] `auto_apply` table and Settings toggles for eligible kinds (`revise`, `promote`, `relist`).
