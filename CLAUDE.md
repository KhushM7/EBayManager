# EBayManager

Automates K's eBay selling: improve existing listings, re-evaluate unsold ones, build new listings from photos, and draft buyer replies. K approves every change to the eBay account: every price, revision, ad rate, listing and buyer message.

Full plan (decisions, eBay API map, rollout): https://claude.ai/artifact/JowUE86DsPhFBsswMms8jf

Design docs: [roadmap](docs/roadmap.md), [safety and environments](docs/safety-and-environments.md), [approvals](docs/approvals.md), [app and dashboard](docs/app-and-dashboard.md).

## Decisions (2026-11-02)

- **Sandbox first.** Everything is built and tested on eBay Sandbox. K's real seller account is connected read-only at Phase 6 and accepts approved writes only from Phase 7. See [safety-and-environments.md](docs/safety-and-environments.md).
- **Every eBay write needs approval**, not only prices and messages. Strict at launch. Later, K may opt eligible kinds into auto-apply. See [approvals.md](docs/approvals.md).
- **One PWA is both the website and the app.** The dashboard is an installable Android PWA with Web Push Approve/Reject, served by the same Worker. ntfy becomes an optional fallback. See [app-and-dashboard.md](docs/app-and-dashboard.md).

## Stack

- TypeScript on Cloudflare Workers, with D1 (SQLite) for state and R2 for photos. Deployed with `wrangler`, with separate `sandbox` and `production` environments that each have their own D1 and R2.
- eBay: Trading API (XML) for existing listings, best offers and revisions; REST APIs (Browse, Inventory, Marketing, Negotiation, Analytics, Taxonomy) elsewhere. Marketplace is EBAY_GB, site ID 3. `EBAY_ENV` (`sandbox` | `production`) selects hosts and keyset.
- Claude: called from the Worker through the Anthropic API with K's key, using `@anthropic-ai/sdk`. This decision was made on 2026-11-01 and replaces the earlier plan to run on the Claude subscription. Use Claude Sonnet 5.5 (`claude-sonnet-5-5`) for listing builds and photo feedback. Use Claude Haiku 5.5 (`claude-haiku-5-5`) for nightly triage and buyer message drafts. The target spend is about $3 to $6 a month.
- Dashboard and PWA: Vite + Preact + TypeScript in `web/`, served as Workers static assets. Cloudflare Access protects `/app/*` and `/api/*`.
- Notifications: Web Push (VAPID) to the installed PWA, with signed Approve/Reject actions. ntfy.sh is the fallback.
- The `/mcp` endpoint stays. It lets K use the same tools from the Claude app or Claude Code when they want to, but nothing depends on it.

## Rules that are enforced in code, never in prompts

These are in `src/rules.ts`. K confirmed the selling rules on 2026-10-12 and the approval rules on 2026-11-02.

- **Every eBay write needs approval.** Anything that changes the eBay account goes through a proposal (`src/proposals.ts`). It changes eBay only after K approves it from a push notification or the dashboard Inbox. Signed links work by POST only. Never add a tool or code path that writes to eBay directly.
- **Locked kinds.** `price`, `message`, `best_offer_response`, `offer_to_watchers`, `create_listing`, `end_listing` and `policy` can never be auto-applied, whatever the dashboard settings say.
- **One write gate.** Only `ebayWrite()` in `src/ebay/write.ts` may call eBay write endpoints. It refuses unless `WRITE_MODE=approval`, the kill switch is off and the proposal is approved. Every write is recorded in `audit_log`.
- **No real account before Phase 6.** Never point the Worker at K's production seller account, or add production seller credentials, before Phase 6 of [the roadmap](docs/roadmap.md). Production Browse comps through the app token are allowed because they link no account.
- **Pricing target.** Price at the lower end of comparable sold prices, adjusted for condition.
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
| `src/notify.ts` | ntfy pushes (Web Push added in Phase 2) |
| `schema.sql` | D1 schema |
| `test/` | Vitest: gate refusal paths (`gate.test.ts`), source scans keeping writes behind the gate (`safety.test.ts`) |
| `docs/` | Design docs and roadmap |
| `src/api.ts`, `web/` | Planned, Phase 2: dashboard API and PWA |
| `src/claude.ts` | Planned, Phase 3: Claude tool-use loop |

## Commands

```sh
npm install
npm run typecheck && npm test   # tsc + vitest
npx wrangler dev                # local, Sandbox; secrets in .dev.vars
npm run deploy:sandbox          # see README for first-time setup
# npm run deploy:production     # not before Phase 6
```

## Next steps

Current phase: **1, safety foundation (sandbox)**. The code is done; the Sandbox deploy and the read-only scope test remain. The checklist is in [docs/roadmap.md](docs/roadmap.md#phase-1-safety-foundation-sandbox).

## Open items

- Sold-price data: Marketplace Insights access has not been requested yet. Until it is, Terapeak is the fallback.
- Confirm whether eBay OAuth read-only scopes restrict Trading API writes. Until confirmed, assume they don't, and rely on `WRITE_MODE`.
- Production keyset (Phase 6): opt out of marketplace account deletion notifications, since the app stores no other users' data.
- Pick a Workers-compatible Web Push library in Phase 2.
- No CI is set up yet.
