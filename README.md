# ebay-autopilot

K's eBay seller service: an Azure Function App that holds the eBay credentials and rules, calls the Claude API for judgement, serves
the dashboard app, and (on Sandbox) exposes MCP tools for the Claude app or Claude Code. See CLAUDE.md for decisions and next steps,
and [azure-migration.md](docs/azure-migration.md) for the move from Cloudflare.

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
| `src/store/` | The data store (Cosmos DB in Azure, in memory in tests); containers in `infra/cosmos-containers.json` |
| `src/platform/azure/`, `infra/` | The Azure Functions adapter and the Bicep templates |

There is deliberately no tool that changes eBay directly. The `propose_*` tools record a proposal and push K an
approval link. Only K's tap on that link (HMAC signed, expiring, POST only) reaches the write gate, which applies it.

## Deploy the Sandbox environment

**Never sign in with your real eBay account here.** The real account is connected read-only at Phase 6
([roadmap](docs/roadmap.md)). Use the eBay **Sandbox** keyset and a Sandbox test user.

```sh
npm install
az login
node scripts/azure-infra.mjs sandbox      # the resources, from infra/main.bicep (region: AZURE_LOCATION, default francecentral)
node scripts/make-keys.mjs                # DASHBOARD_KEY and VAPID_KEY into .dev.vars if missing
node scripts/azure-secrets.mjs sandbox    # .dev.vars into the Sandbox Key Vault (values never printed)
node scripts/azure-deploy.mjs sandbox     # typecheck, tests, build, deploy; prints the address
```

Then:

1. In the eBay developer portal (Sandbox keyset, User Tokens), set the RuName's "auth accepted URL" to `<PUBLIC_URL>/oauth/callback`.
2. Sign in to the dashboard as the owner, then Settings → **Connect the eBay account**, and sign in with the Sandbox test user.
3. Optional (Sandbox only): add a custom connector in Claude settings: URL `<PUBLIC_URL>/mcp`, request header `Authorization: Bearer <MCP_TOKEN>`.
4. Install the app and turn on notifications in Settings. ntfy (`NTFY_TOPIC`) is an optional fallback.

`<PUBLIC_URL>/health` shows the environment and write mode to a signed-in person, or with `X-Health-Key: <DASHBOARD_KEY>`. Anyone can pause all eBay changes from Settings (or the `pause_writes`
tool); only the owner resumes them, from Settings.

## Dashboard and Android app

The app also serves the dashboard at its root address, to signed-in people only: everyone else sees a blank page. K sets up
who can sign in (themselves and up to two managers) with `node scripts/people.mjs <env> add --email ... --name ... --role ...`,
which shows a QR code for Google or Microsoft Authenticator and the hidden sign-in address. People sign in there with their
email and the 6-digit code. On Sandbox only, `DASHBOARD_KEY` from `.dev.vars` also signs in (through the API).

On Android: open the URL in Chrome, choose **Install app**, sign in, then **Settings → Turn on for this device**.
Approval notifications then carry Approve and Reject buttons that act without opening the app.

## Develop

```sh
npm run typecheck && npm test
MOCK=1 npm run dev:web  # the dashboard on sample data, no account needed
npm run test:cosmos     # the store's conformance tests against the Cosmos DB emulator (if installed)
```
