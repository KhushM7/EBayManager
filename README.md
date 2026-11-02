# ebay-autopilot

K's eBay seller service: a Cloudflare Worker that holds the eBay credentials and rules, calls the Claude API for judgement, and exposes
MCP tools for optional use from the Claude app or Claude Code. See CLAUDE.md for decisions and next steps.

Plan: https://claude.ai/artifact/JowUE86DsPhFBsswMms8jf

Design docs: [roadmap](docs/roadmap.md) · [safety and environments](docs/safety-and-environments.md) ·
[approvals](docs/approvals.md) · [app and dashboard](docs/app-and-dashboard.md)

## What's here (Phase 1)

| Path | Does |
| --- | --- |
| `src/ebay/hosts.ts` | Sandbox or production eBay hosts from `EBAY_ENV`; anything else fails closed |
| `src/ebay/auth.ts` | eBay OAuth: one-time sign-in (read-only scopes unless writes are on), refresh, app token for comps |
| `src/ebay/trading.ts` | Trading API reads: active listings, item detail. Refuses any non-read verb |
| `src/ebay/write.ts` | The write gate: the only code that sends eBay writes, with the kill switch and audit log |
| `src/ebay/browse.ts` | Active competing listings and low/median/high summary |
| `src/proposals.ts` | Every eBay change is a proposal; signed, expiring approval links |
| `src/notify.ts` | Push to K's phone via ntfy with Approve / Reject, prefixed `[SANDBOX]` or `[READ-ONLY]` |
| `src/tools.ts`, `src/mcp.ts` | MCP tools over Streamable HTTP at `/mcp` |
| `src/rules.ts` | House rules and locked approval kinds, enforced in code |
| `schema.sql` | D1 tables: tokens, snapshots, item settings, proposals, audit log, settings |

There is deliberately no tool that changes eBay directly. The `propose_*` tools record a proposal and push K an
approval link. Only K's tap on that link (HMAC signed, expiring, POST only) reaches the write gate, which applies it.

## Deploy the Sandbox environment

**Never sign in with your real eBay account here.** The real account is connected read-only at Phase 6
([roadmap](docs/roadmap.md)). Use the eBay **Sandbox** keyset and a Sandbox test user.

```sh
npm install
npx wrangler login
npx wrangler d1 create ebay-autopilot-sandbox          # paste database_id into [env.sandbox] in wrangler.toml
npm run db:init:sandbox
for s in EBAY_APP_ID EBAY_CERT_ID EBAY_DEV_ID EBAY_RUNAME MCP_TOKEN SIGNING_KEY NTFY_TOPIC; do npx wrangler secret put $s --env sandbox; done
npm run deploy:sandbox                                 # set PUBLIC_URL in [env.sandbox] to the printed URL, deploy again
```

Then:

1. In the eBay developer portal (Sandbox keyset, User Tokens), set the RuName's "auth accepted URL" to `<PUBLIC_URL>/oauth/callback`.
2. Open `<PUBLIC_URL>/oauth/start?key=<MCP_TOKEN>` and sign in with the Sandbox test user.
3. Optional: add a custom connector in Claude settings: URL `<PUBLIC_URL>/mcp`, request header `Authorization: Bearer <MCP_TOKEN>`.
4. Subscribe to `NTFY_TOPIC` in the ntfy app.

`<PUBLIC_URL>/health` shows the environment and write mode. The `pause_writes` tool stops all eBay writes at once;
`npm run writes:resume:sandbox` resumes them.

## Dashboard and Android app

The Worker also serves the dashboard at its root URL. Sign in with `DASHBOARD_KEY` from `.dev.vars`
(`node scripts/make-keys.mjs` adds it and `VAPID_KEY` if missing; upload with
`npx wrangler secret bulk .dev.vars --env sandbox`).

On Android: open the URL in Chrome, choose **Install app**, sign in, then **Settings → Turn on for this device**.
Approval notifications then carry Approve and Reject buttons that act without opening the app.

## Develop

```sh
npm run typecheck && npm test
npx wrangler dev        # local, Sandbox, with secrets from .dev.vars; run `npm run db:init:local` first
MOCK=1 npm run dev:web  # the dashboard on sample data, no account needed
```
