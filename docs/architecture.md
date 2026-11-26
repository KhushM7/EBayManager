# Architecture

How EBayManager runs on Azure, where its data lives and how it is deployed. The rules it enforces are in
[security.md](security.md) and [approvals.md](approvals.md); the two environments in
[safety-and-environments.md](safety-and-environments.md).

## Overview

```
 Phone / desktop (installed PWA)            eBay (Trading XML + REST APIs)
            │  session cookie + X-EbayManager            ▲
            ▼                                            │ reads; writes only via ebayWrite()
 ┌──────────────────────────── Azure Function App (Node 22, Flex Consumption) ───────────────┐
 │  app (HTTP)    → src/index.ts handle(): web app, /api/*, /oauth/*, /decide/*, /ebay/*      │
 │  nightly 02:00 → snapshot, sync, health flags, pricing, sales ladder, triage, proposals    │
 │  poll  5 min   → offers, buyer questions, sales; service checks every 15 min               │
 │  background    → long jobs from the Storage Queue (audits, listing builds, price checks)   │
 └───────┬───────────────┬──────────────────┬──────────────────┬─────────────────────────────┘
         ▼               ▼                  ▼                  ▼
   Cosmos DB (NoSQL)  Blob Storage       Key Vault        Anthropic API, Trawl, CompsAPI,
   one database per   photos, exports,   secrets as app   Parcel2Go, photo AI container
   environment        deployments        settings         (all optional except Claude)
```

The app is written against web-standard `Request`/`Response` (`handle(request, env)` and `runScheduled()` in
`src/index.ts`), so the Azure layer is a thin adapter in `src/platform/azure/`:

| File | Does |
| --- | --- |
| `functions.ts` | The four functions: `app` (every HTTP request; `host.json` sets `routePrefix: ""`), `nightly`, `poll` and `background` |
| `env.ts` | Builds the app's `Env` from app settings; Cosmos DB and Blob Storage through the app's managed identity. Refuses to start in production with test sign-in or `/mcp` switched on |
| `static.ts` | Serves the built web app (`web/dist`) with the single-page-app fallback and security headers on every response |

Background work an HTTP response can't wait for (a first-day audit, a listing build) goes on the `jobs` Storage
Queue (`src/background.ts`); the web app polls `GET /api/jobs/:id`. Without a queue (tests, local runs) jobs run
inline.

## Azure resources

One Bicep template (`infra/main.bicep`) deploys one environment per run. Names end in a short suffix derived from
the subscription id, so two people's deployments never clash.

| Resource group | Holds |
| --- | --- |
| `rg-ebay-shared` | The Cosmos DB account (`cosmos-ebay-<suffix>`), free tier, shared by both environments |
| `rg-ebay-sandbox`, `rg-ebay-production` | Function App `ebay-autopilot-<env>-<suffix>` (Flex Consumption plan), storage account (photos, exports, deployment packages, the `jobs` queue), Key Vault, Log Analytics and Application Insights, and optionally the photo AI Container App |

- **Cosmos DB:** databases `ebay-sandbox` and `ebay-production` in one free-tier account. Each Function App's
  managed identity may read and write only its own database. The person who deploys may read both (diagnosis,
  `scripts/prod-query.mjs`) and write only Sandbox. Account keys are disabled.
- **Containers** are listed in `infra/cosmos-containers.json` (partition key `/pk` everywhere, TTLs, indexes); a
  test checks the file matches the code. Treat edits there like a database migration.
- **Secrets** live in Key Vault and reach the app as Key Vault references in its settings. Azure caches them for
  up to 24 hours; `node scripts/people.mjs <env> refresh` restarts the app so new values apply at once.
- **Budget:** a monthly budget alert (default $5) emails the subscription owners at 50% and 100%.
- **Region:** `francecentral` by default; set `AZURE_LOCATION` before `azure-infra.mjs` to choose another region
  that supports Flex Consumption.

## The data store

Code never touches Cosmos DB directly. `src/store/doc.ts` is a small document layer with two implementations that
behave the same way: `cosmos.ts` (conditional patch, etag replace, transactional batch) and `memory.ts` (tests).
Repositories in `src/store/` sit on top, and `env.store` is the only way in. `test/safety.test.ts` fails if
anything outside `src/store/` reads documents or if `@azure/*` is imported outside the store and platform layer.
`npm run test:cosmos` runs the store's conformance tests against the Cosmos DB emulator.

## Logs and monitoring

- `src/log.ts` writes one short JSON line per event to Azure's logs and an event to the `jobs` container (14 days;
  problems 90). Tokens and personal details are removed first (`src/redact.ts`). Never use a bare
  `.catch(() => null)`: use `swallow()`, which logs.
- Daily log caps keep Azure's free 5 GB a month: 0.1 GB production, 0.05 GB Sandbox. `host.json` keeps the
  Functions host's own chatter out.
- `src/monitor.ts`: the nightly run watches the poll and the poll watches the nightly run; a stopped or failing
  check files an Inbox to-do with a notification. `src/services.ts` does the same for each outside service.
- `.github/workflows/uptime.yml` checks the app from outside every hour once the repository variable
  `UPTIME_URL` is set; GitHub emails on failure.
- Read logs with `node scripts/logs.mjs sandbox|production [--since 24h] [--errors] [--item <id>] [--run <id>]`.

## Build and deploy

- `npm run build:azure` (`scripts/build-azure.mjs`) builds the web app and bundles the functions to `dist/azure`.
- `node scripts/azure-deploy.mjs <env>` runs typecheck and tests, builds, zips and publishes. Production needs
  `EBAY_CONFIRM_PRODUCTION=yes`.
- `.github/workflows/deploy.yml` does the same from GitHub with OpenID Connect (no stored password); production
  waits for a required reviewer and deploys only from `main`. One-time set-up: `scripts/azure-github-oidc.mjs`.
- `node scripts/check-production.mjs [sandbox]` checks a deployed environment from outside (headers, hidden
  routes, HTTPS, the Functions admin endpoints closed, Cosmos keys disabled). It reads only.
