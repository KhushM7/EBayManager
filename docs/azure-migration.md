# Azure migration: progress

Moving EBayManager from Cloudflare (Workers, D1, R2, static assets, cron) to Azure (Functions on Flex Consumption, Cosmos DB free tier, Blob Storage, Key Vault). The plan was approved by K on 2026-11-03. This file is updated after every step: what's done, the evidence, and anything open.

**Why:** Cloudflare's free plan allows 50 outgoing calls, 50 database queries and 10 ms of CPU per run. That broke the production first-day audit on 2026-11-03. K chose Azure for Students over Workers Paid.

**Rule:** every safeguard is kept or made stronger. If something can't be replaced like for like, work stops and K decides. Nothing is skipped.

**Finish line:** the same point as before the move. That means Phase 7, the real account connected read-only, `WRITE_MODE=off`, all proposals dry runs, the same data, and go-live tests A to H next.

## Decisions (K, 2026-11-03)

| Topic | Decision |
| --- | --- |
| Database | Azure Cosmos DB for NoSQL, free tier: one account, two databases (`ebay-sandbox`, `ebay-production`) at 400 RU/s each |
| Region | France Central (`francecentral`). UK South, West Europe and North Europe aren't allowed by the Students policy; France Central, Belgium Central, Austria East and Norway East are allowed and support Flex Consumption. France Central was picked over Belgium Central as the longer-established region for Cosmos DB |
| Web address | The free `*.azurewebsites.net` address |
| Cloudflare after the move | Scheduled jobs stop at switch-over; the Worker and its data are kept read-only for 2 weeks, then deleted |
| Pull request for Phase 7 | The GitHub CLI isn't installed here. K opens it: https://github.com/KhushM7/EBayManager/compare/main...phase-7-first-day-audit (then a second one for `azure-migration`) |

## Steps

Who does each step: **C** = Claude, **K** = K.

### M0. Branch and this doc
- [x] (C) Branch `azure-migration` from `phase-7-first-day-audit` (2026-11-03)
- [x] (C) Create this progress doc
- [x] (K) Open the Phase 7 pull request and merge it (2026-11-04)

### M1. Store layer (replaces D1)
- [x] (C) Store interface (`src/store/index.ts`), built on a small document layer (`src/store/doc.ts`), so only that layer has two implementations and the repositories (`src/store/{proposals,auth,data}.ts`) are written and tested once
- [x] (C) `src/store/memory.ts`: in-memory store for tests, with Cosmos DB semantics
- [x] (C) `src/store/cosmos.ts`: Cosmos DB store (`@azure/cosmos`; conditional patch, etag replace, transactional batch)
- [x] (C) `infra/cosmos-containers.json`: the 14 containers, partition keys, TTL, indexing (a test checks it matches the code)
- [x] (C) Conformance tests (`test/store/conformance.ts`): memory always (14 tests); emulator via `npm run test:cosmos` (needs the emulator: open question 3)
- [x] (C) Convert every call site (25 files) from `env.DB` to `env.store`
- [x] (C) Convert the tests that use SQL directly to the store and shared fixtures (`test/fixtures.ts`)
- [x] (C) ~~Differential test (old SQL against the new store)~~: replaced by a golden test of `metrics()` with hand-worked figures (`test/metrics.test.ts`). The old SQL was converted file by file in the same commit, so there was no point at which both could run side by side; the golden test pins the same behaviour, including SQLite's SUM-of-nulls and the per-order-item revenue
- [x] (C) Concurrency tests: the write-gate claim (1 of 10), approve-once, never a dry run, never after expiry, one pending proposal per superseding kind under 6 simultaneous creates, invite / recovery code / challenge used once, parallel usage increments, removing a person
- [x] (C) Safety scans: no `env.DB`, `D1Database` or `prepare(`; `@azure/*` only in `src/store/cosmos*` and `src/platform/azure/`; only `src/store/` touches documents; `promote` is locked

### M2. Azure platform layer
- [x] (C) `handle(request, env)` and `runScheduled()` in `src/index.ts`, platform-neutral
- [x] (C) HTTP adapter (`src/platform/azure/functions.ts`: catch-all, `routePrefix: ""` in `host.json`), static `web/dist` from memory with SPA fallback (`static.ts`), security headers on **every** response with HSTS and X-Frame-Options; server pages and data get stricter CSPs than the app
- [x] (C) Client IP from `X-Client-IP` only (anything else is "unknown"); per-person limit of 5 failed passkey sign-ins per 15 minutes (`completeLogin`), on top of the 20 per hour per network
- [x] (C) Timer triggers `0 0 2 * * *` and `0 */15 * * * *`
- [x] (C) Background jobs (`src/background.ts`): Storage Queue `jobs`, queue-triggered `background` function, run-once claim, push when done or failed, `GET /api/jobs/:id`; the web app waits on them (`apiJob`). Without a queue (tests, local) they run inline, so behaviour there is unchanged
- [x] (C) Env from app settings (`src/platform/azure/env.ts`); Cosmos through `DefaultAzureCredential` (managed identity); refuses to start in production with key sign-in or /mcp switched on. Blob (photos) is created by Bicep and wired in Phase 10, where it's first used, as R2 was
- [x] (C) `@cloudflare/workers-types` removed (Node types; byte buffers cast for the DOM types); `npm run build:azure` bundles to `dist/azure`. wrangler stays as a dev tool until M6 (it exports the D1 data and stops Cloudflare's scheduled jobs), then goes in M8

### M3. Infrastructure as code and scripts
- [x] (C) `infra/main.bicep` (subscription scope) with `modules/cosmos.bicep`, `cosmos-access.bicep`, `app.bicep`, and `sandbox.bicepparam` / `production.bicepparam`. Production is forced to `WRITE_MODE=off` and no test sign-in or /mcp in the template itself, whatever the parameters say
- [x] (C) Validate the templates (Bicep 0.37.4, 2026-11-04): fixed a loop inside a function call in `cosmos.bicep` (now `map()`), removed a redundant `dependsOn`; `functionsRuntimeAdminIsolationEnabled` isn't in Bicep's type library yet, so its warning is suppressed and the /admin check verifies it
- [x] (C) Scripts: `azure-infra.mjs`, `azure-secrets.mjs` (values never printed; temp file deleted at once), `azure-deploy.mjs` (runs typecheck and tests first), `prod-query.mjs` (read-only, SELECT only, Data Reader role), `migrate-d1-to-cosmos.ts` (`npm run migrate:d1`). Every production command refuses to run without `EBAY_CONFIRM_PRODUCTION=yes`. ~~`cosmos-setting.mjs`~~: not needed. Resuming writes is owner-only in the app's Settings, and on production K deliberately has read-only data access
- [x] (C) Import mapping (`src/store/migrate.ts`, tested in `test/migrate.test.ts`); **dry run on the real Sandbox D1 export passed**: 59 documents, every table, sampled documents and old-vs-new metrics match
- [x] (C) `check-production.mjs` takes its address from the deployment, and adds: HSTS and no framing, headers on API responses, plain HTTP redirects to HTTPS, /admin closed, HTTPS-only/TLS/FTP/CORS settings, basic-auth publishing off, Cosmos keys disabled and free tier

### M4. Sandbox on Azure
- [x] (K) `az login`; find the allowed regions: France Central chosen (2026-11-04)
- [x] (C) Deploy sandbox infrastructure (France Central) and code; (K) secrets uploaded from `.dev.vars` (9 of 15: the Claude, sold-data, comps keyset and deletion-token keys aren't in `.dev.vars`). App: https://ebay-autopilot-sandbox-wrpoyt.azurewebsites.net; `/health` shows sandbox, approval
- [ ] (C) Import Sandbox D1 into Cosmos and verify
- [ ] (K) eBay portal: Sandbox RuName accept URL → new address `/oauth/callback`
- [ ] (C) Verify: key sign-in, an approved price change applied to a test listing, the offer round trip, nightly and audit as background jobs, push, headers and HTTPS settings, forged `X-Client-IP` ignored, RU peaks

### M5. Production infrastructure
- [ ] (K) Deploy production infrastructure, secrets and code (`WRITE_MODE=off`); `/health` shows production and off

### M6. Switch-over
- [ ] (K) Pause writes on Cloudflare and remove its scheduled jobs
- [ ] (K) Export production D1, import into Cosmos, verify (counts, checksums, sample rows, `metrics()` identical)
- [ ] (K) eBay portal: production RuName accept URL and account-deletion endpoint → new address; C6 challenge passes
- [ ] (K) Register a new passkey from the re-enrolment invite, save the recovery codes, install the app, turn on notifications
- [ ] (K) `node scripts/check-production.mjs` passes

### M7. Back to the same point
- [ ] (K) Run the first-day audit; it finishes with no failed steps
- [ ] (C) Data check: floors and facts, proposals (4 approved dry runs, 7 rejected), sold-data counters, specs, style guide, reports, Claude usage
- [ ] (K) One full nightly cycle on Azure with no failed steps
- [ ] (C) Docs updated: CLAUDE.md, README, security.md, safety-and-environments.md, app-and-dashboard.md, go-live-tests.md, roadmap.md, privacy.html; free-plan-queue.md marked superseded

### M8. Two weeks later
- [ ] (K) Delete the Cloudflare Workers, D1 databases and R2 buckets, and the `.d1-*.sql` exports

## State before the move (2026-11-03, to match afterwards)

Production D1:
- 4 active listings
- 23 orders (imported Seller Hub sales plus the eBay API)
- Proposals: 4 approved as dry runs, 7 rejected, none applied; `audit_log` has no applied entries
- 2 first-day audit reports
- Product specs stored for 1 listing
- Price decisions for 4 listings
- A floor and facts set on 1 listing (the TV stand, floor £55)
- 1 user (K, owner, 1 passkey)
- 1 push device
- The style guide is the plain default (the learned one was lost to the subrequest limit; it relearns when the audit runs again)
- Sold-data usage this month: Trawl 26/250, CompsAPI 27/100

## Open questions and issues

| # | Question | Status |
| --- | --- | --- |
| 1 | Does Flex Consumption's free grant apply to a Students subscription? If not, expect under $1/month from the credit | Check the first cost view |
| 2 | Allowed regions on K's subscription: need one with both Flex and Cosmos | Done: France Central (default in the param files and `azure-infra.mjs`) |
| 3 | Install the Cosmos DB emulator on K's PC for the full conformance run | Ask K before installing |
| 4 | Does App Service overwrite a forged `X-Client-IP` on Flex? | Test at M4; stop and discuss if not |

## Log

- 2026-11-04: Sandbox deployed to Azure from the cloud session. First deploy failed: Cosmos rejects `/id/?` as an index path (id is a system property, always indexed) and `auth` listed `/user_id/?` twice; both removed, with a test. `/health` 200 (sandbox, approval); HSTS, X-Frame-Options DENY, nosniff and CSP present; `/admin/host/status` 401; HTTPS only, TLS 1.2, FTP off, no CORS.
- 2026-11-04: Production dry run (K): 246 documents, every table and the sampled documents matched; the one failure was a false alarm (proposal counts in a different key order). The metrics check now sorts object keys before comparing.
- 2026-11-04: K merged the Phase 7 pull request and chose France Central (the UK and West/North Europe regions aren't allowed by the Students policy). Defaults switched from `uksouth` to `francecentral`.
- 2026-11-03: plan approved; branch and this doc created.
- 2026-11-04: M3 written. The importer dry run on the Sandbox export matched (a float rounding difference in summed costs was a false alarm; the check now compares to 1e-9). Template validation waits for the Azure CLI.
- 2026-11-04: M2 done: 209 tests pass (1 skipped). The function package builds (`npm run build:azure`); it is first run for real on Sandbox at M4.
- 2026-11-04: M1 done. All 25 modules moved to the store; 201 tests pass (1 skipped: the emulator suite). Found and fixed on the way: a date bug in the audit's "days listed" (it used the wall clock), and supersede retries too short under 6 simultaneous creates (now 25 with back-off). Two claims made atomic that weren't before: recovery codes and sign-in challenges.
