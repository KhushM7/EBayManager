# Roadmap

The real eBay seller account is connected read-only at Phase 6 and starts accepting approved writes at Phase 7. Everything before that runs on eBay Sandbox. Each phase ends with a gate that must pass before the next starts.

Updated 2026-11-02. Design details: [safety-and-environments.md](safety-and-environments.md), [approvals.md](approvals.md), [app-and-dashboard.md](app-and-dashboard.md).

**Current phase: 1. Safety foundation.**

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
- [ ] Deploy `--env sandbox`, sign in with a sandbox test user, create 3–5 test listings via approved proposals.
- [ ] Confirm on Sandbox that read-only scopes don't stop Trading API writes: sign in with `/oauth/start?readonly=1`, approve a price change on a test listing. eBay's docs say the traditional APIs ignore scopes; record the result in safety-and-environments.md.

## Phase 2: App shell (sandbox)

- [ ] `web/` Vite + Preact app served by Workers static assets; Cloudflare Access on `/app/*` and `/api/*`; Access JWT check in the Worker.
- [ ] `src/api.ts`: proposals list, decide (single and batch), listings, settings, push subscribe.
- [ ] Inbox, Listings, Activity and Settings screens; environment banner.
- [ ] Manifest and service worker; Web Push with VAPID; `push_subscriptions` table; test push; notification actions that POST the decision.
- [ ] `src/notify.ts` sends Web Push first, ntfy as a fallback if configured.

## Phase 3: Claude (sandbox)

- [ ] `ANTHROPIC_API_KEY` secret; `src/claude.ts` tool-use loop over `src/tools.ts` with `claude-sonnet-5-5`.
- [ ] Listing audit: for each listing, propose title, item specifics, description, price and ad rate, each as its own proposal.
- [ ] Batch review in the Inbox.
- [ ] `claude_usage` table logged on every call.

## Phase 4: Metrics and nightly health (sandbox)

- [ ] Nightly sync of orders (Fulfillment API) and traffic (Analytics API).
- [ ] Rule-based health score per listing, no Claude.
- [ ] Only flagged listings go to `claude-haiku-5-5` for triage; any change is a proposal.
- [ ] Metrics and Listing detail screens with charts.

## Phase 5: Buyer messages and offers (sandbox)

- [ ] eBay notifications for questions and Best Offers into the Worker.
- [ ] Haiku drafts a reply or counter → proposal → push → K approves → sent.
- [ ] Round trip tested with a second sandbox user acting as buyer.

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
