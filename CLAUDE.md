# EBayManager

Automates K's eBay selling: improve existing listings, re-evaluate unsold ones, build new listings from photos, and draft buyer replies. K approves every price and every buyer message.

Full plan (decisions, eBay API map, rollout): https://claude.ai/code/artifact/9039237c-08b7-4e30-a3d7-683e24431d36

## Stack

- TypeScript on Cloudflare Workers, with D1 (SQLite) for state and R2 for photos. Deployed with `wrangler`.
- eBay: Trading API (XML) for existing listings, best offers and revisions; REST APIs (Browse, Inventory, Marketing, Negotiation, Analytics, Taxonomy) elsewhere. Marketplace is EBAY_GB, site ID 3.
- Claude: called from the Worker through the Anthropic API with K's key, using `@anthropic-ai/sdk`. This decision was made on 2026-11-01 and replaces the earlier plan to run on the Claude subscription. Use Claude Sonnet 5.5 (`claude-sonnet-5-5`) for listing builds and photo feedback. Use Claude Haiku 5.5 (`claude-haiku-5-5`) for nightly triage and buyer message drafts. The target spend is about $3 to $6 a month.
- The `/mcp` endpoint stays. It lets K use the same tools from the Claude app or Claude Code when they want to, but nothing depends on it.
- Push notifications go through ntfy.sh, with signed one-tap approval links.

## Rules that are enforced in code, never in prompts

These are in `src/rules.ts`. K confirmed them on 2026-10-12.

- **Prices need approval.** Every price, new or changed, goes through a proposal (`src/proposals.ts`) and changes on eBay only after K taps a signed approval link, which works by POST only. Never add a tool or code path that changes a price or sends a buyer message directly.
- **Pricing target.** Price at the lower end of comparable sold prices, adjusted for condition.
- **Returns.** Always accepted, and the buyer pays return postage. This is set as an eBay business policy.
- **Shipping.** Assume K has a box and ships the item, unless they say collection only.
- **Negotiation.** K leads it. Claude only drafts replies, and K approves each message and counter-offer.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Routes: `/mcp`, `/oauth/start`, `/oauth/callback`, `/decide/:id`, `/health`, and the nightly cron |
| `src/ebay/` | eBay OAuth, the Trading API client, and Browse comps |
| `src/proposals.ts` | Proposals, signed approval links, and applying approved changes |
| `src/tools.ts`, `src/mcp.ts` | Tool definitions and a minimal stateless MCP server |
| `src/notify.ts` | ntfy pushes |
| `schema.sql` | D1 schema |

## Commands

```sh
npm install
npm run typecheck && npm test   # tsc + vitest
npx wrangler dev                # local
npm run deploy                  # see README for first-time setup
```

## Next steps

1. Merge PR #1 (the Phase 0 skeleton). Then deploy, sign in to eBay once, and confirm `list_active_listings` returns real data.
2. Add `ANTHROPIC_API_KEY` as a Worker secret, plus a `src/claude.ts` that runs a tool-use loop over the tools in `src/tools.ts`.
3. Phase 1 audit. For each current listing, propose a new title, item specifics, description, price and ad rate. Put all proposals on one review page for K to approve in a batch.
4. Phase 2. A nightly cron scores listing health without Claude. Only flagged listings go to Haiku, and price changes still go through proposals.
5. Phase 3. eBay notifications feed into Haiku drafts, then an approval push, then sending on K's tap.
6. Phase 4. Listing from photos through a small web page or Telegram bot, with photo-quality feedback, then Inventory API publish.

## Open items

- Sold-price data: Marketplace Insights access has not been requested yet. Until it is, Terapeak is the fallback.
- No CI is set up yet.
