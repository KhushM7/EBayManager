# ebay-autopilot

K's eBay seller service: a Cloudflare Worker that holds the eBay credentials and rules, calls the Claude API for judgement, and exposes
MCP tools for optional use from the Claude app or Claude Code. See CLAUDE.md for decisions and next steps.

Plan: https://claude.ai/code/artifact/9039237c-08b7-4e30-a3d7-683e24431d36

## What's here (Phase 0)

| Path | Does |
| --- | --- |
| `src/ebay/auth.ts` | eBay OAuth: one-time sign-in, refresh, app token for Browse |
| `src/ebay/trading.ts` | Trading API: active listings, item detail, price revise |
| `src/ebay/browse.ts` | Active competing listings and low/median/high summary |
| `src/proposals.ts` | Every price or message is a proposal; signed one-tap approval links apply it |
| `src/notify.ts` | Push to K's phone via ntfy with Approve / Reject |
| `src/tools.ts`, `src/mcp.ts` | MCP tools over Streamable HTTP at `/mcp` |
| `src/rules.ts` | House rules, enforced in code |
| `schema.sql` | D1 tables: tokens, snapshots, item settings, proposals |

There is deliberately no tool that changes a price directly: `propose_price_change` records it and pushes
K an approval link, and only K's tap on that link (HMAC signed, POST only) calls eBay.

## Deploy

```sh
npm install
npx wrangler d1 create ebay-autopilot        # paste database_id into wrangler.toml
npx wrangler r2 bucket create ebay-autopilot-photos
npm run db:init
for s in EBAY_APP_ID EBAY_CERT_ID EBAY_DEV_ID EBAY_RUNAME MCP_TOKEN SIGNING_KEY NTFY_TOPIC; do npx wrangler secret put $s; done
npm run deploy                                # set PUBLIC_URL in wrangler.toml to the printed URL, deploy again
```

Then:

1. In the eBay developer portal, set the RuName's "auth accepted URL" to `<PUBLIC_URL>/oauth/callback`.
2. Open `<PUBLIC_URL>/oauth/start?key=<MCP_TOKEN>` once and sign in to eBay.
3. In Claude settings, add a custom connector: URL `<PUBLIC_URL>/mcp`, request header `Authorization: Bearer <MCP_TOKEN>`.
4. Subscribe to `NTFY_TOPIC` in the ntfy app.

## Develop

```sh
npm run typecheck && npm test
```
