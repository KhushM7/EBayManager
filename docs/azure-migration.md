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
- [x] (C) Client IP from `Client-IP` only, port removed (anything else is "unknown"; was `X-Client-IP` until the Sandbox test below showed it can be forged); per-person limit of 5 failed passkey sign-ins per 15 minutes (`completeLogin`), on top of the 20 per hour per network
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
- [x] (K) eBay portal: Sandbox RuName accept URL → new address `/oauth/callback` (round trip verified: tokens refreshed 02:32 UTC)
- [x] (C/K) Verify (2026-11-04): passkey sign-in (key sign-in is API-only), two approved price changes applied, nightly and audit, push, headers and HTTPS settings, forged client address ignored (after the `Client-IP` fix), RU peaks. The offer round trip was **not re-run**: eBay's Sandbox site was down; it passed on Cloudflare on 2026-11-02 and the offer code is unchanged apart from the store, which has its own conformance tests (K's decision)

### M5. Production infrastructure
- [x] (K) Deploy production infrastructure, secrets and code (`WRITE_MODE=off`); `/health` shows production and off (2026-11-04: https://ebay-autopilot-production-wrpoyt.azurewebsites.net). Secrets: 11 uploaded; the comps keyset, `MCP_TOKEN` and `NTFY_TOPIC` are intentionally unset on production
- [x] (K) Redeploy the code with the fixed zip step; the dashboard page loads (sign-in page, 2026-11-04)

### M6. Switch-over
- [x] (K) Pause writes on Cloudflare and remove its scheduled jobs (2026-11-05: `writes_paused` = 1 in production D1; `[env.*.triggers] crons = []` in `wrangler.toml`, applied with `npx wrangler triggers deploy`; the Cloudflare API shows no schedules on either Worker, Sandbox removed by C)
- [x] (K) Export production D1, import into Cosmos, verify (counts, checksums, sample rows, `metrics()` identical) (2026-11-05: 281 documents verified; the temporary write role removed, K back to Data Reader on production)

  Write access for the import (K has only Data Reader on production). Grant it just before the import, and remove it straight after:
  ```powershell
  $acct = az deployment sub show --name ebay-production --query properties.outputs.cosmosAccount.value -o tsv
  $acctId = az cosmosdb show -g rg-ebay-shared -n $acct --query id -o tsv
  $me = az ad signed-in-user show --query id -o tsv
  # grant (Cosmos DB Built-in Data Contributor, the production database only)
  az cosmosdb sql role assignment create -g rg-ebay-shared -a $acct --role-definition-id 00000000-0000-0000-0000-000000000002 --principal-id $me --scope "$acctId/dbs/ebay-production"
  # remove
  $id = az cosmosdb sql role assignment list -g rg-ebay-shared -a $acct --query "[?principalId=='$me' && ends_with(roleDefinitionId, '00000000-0000-0000-0000-000000000002') && ends_with(scope, '/dbs/ebay-production')].name" -o tsv
  # $id must be exactly one GUID: K also holds Data Contributor on ebay-sandbox (from the template), which stays
  az cosmosdb sql role assignment delete -g rg-ebay-shared -a $acct --role-assignment-id $id --yes
  ```
- [x] (K) eBay portal: production RuName accept URL and account-deletion endpoint → new address; C6 challenge passes (2026-11-05: both saved, the challenge verified and eBay's test notification succeeded)
- [x] (K) Register a new passkey from the re-enrolment invite, save the recovery codes, install the app, turn on notifications (2026-11-05: a test notification arrived)
- [x] (K) `node scripts/check-production.mjs` passes (2026-11-05: all 25 checks, A6, B1, B2, B7, B8, AZ and C6)

### M7. Back to the same point
- [x] (K) Run the first-day audit; it finishes with no failed steps (2026-11-05 00:58 UTC: every step completed, including those that failed on Cloudflare)
- [x] (C) Data check: floors and facts, proposals (4 approved dry runs, 7 rejected, 3 pending) (2026-11-05, see the log), sold-data counters, specs, style guide, reports, Claude usage
- [x] (K) One full nightly cycle on Azure with no failed steps (2026-11-05: Run now at 01:14 UTC, then the 02:00 UTC timer run, both with no failed steps)
- [x] (C) Docs updated: CLAUDE.md, README, security.md, safety-and-environments.md, app-and-dashboard.md, go-live-tests.md, roadmap.md, privacy.html; free-plan-queue.md marked superseded (2026-11-05; also approvals.md and listing-assistant.md)

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

At the switch-over export (2026-11-05), after the last Cloudflare runs: 281 documents planned (dry run verified). Changes since 2026-11-03: 3 more proposals, **pending** dry runs from the 2026-11-04 nightly (14 in all: 4 agreed, 7 rejected, 3 pending; none applied); product specs for 4 listings; sold-data usage Trawl 29/250, CompsAPI 31/100. Not carried over by design: 2 sessions, 15 sign-in attempts, 1 push device, 1 passkey, 1 invite (all bound to the old address).

## Open questions and issues

| # | Question | Status |
| --- | --- | --- |
| 1 | Does Flex Consumption's free grant apply to a Students subscription? If not, expect under $1/month from the credit | Check the first cost view |
| 2 | Allowed regions on K's subscription: need one with both Flex and Cosmos | Done: France Central (default in the param files and `azure-infra.mjs`) |
| 3 | Install the Cosmos DB emulator on K's PC for the full conformance run | Ask K before installing |
| 4 | Does App Service overwrite a forged `X-Client-IP` on Flex? | **No.** Resolved 2026-11-04 (K chose to find a trustworthy header): a Sandbox-only diagnostic showed the front end overwrites `Client-IP` (as `ip:port`) and appends the real address to `X-Forwarded-For`; `X-Client-IP`, `X-Real-IP`, `X-Azure-ClientIP`, `X-Azure-SocketIP` and `X-Original-For` pass forged values through. The app now reads `Client-IP` only; diagnostic removed |

## Log

- 2026-11-05: **M7 complete.** Docs describe Azure as it runs now (Cloudflare entries kept as history in the roadmap and logs); privacy.html names Azure, EU. Back at the same point as before the move: Phase 7, read-only, `WRITE_MODE=off`, all proposals dry runs, the same data plus today's runs. Next: go-live tests A to H; M8 (delete Cloudflare) about 2026-11-19.

- 2026-11-05: **The 02:00 UTC nightly ran on Azure's timer** with no failed steps: 4 listings, 2 orders, traffic for 7, 3 flagged and triaged, 4 dry-run proposals, to-dos 1 opened. Only the docs update is left in M7.

- 2026-11-05: Nightly run on Azure (K, Run now on Metrics, 01:14 UTC): no failed steps. 4 listings, 2 orders, traffic for 7 listings, 1 flagged and triaged, prices 0 priced (the audit had just priced them), 15 outcomes learned, bundles skipped (made this week), no proposals. The 02:00 UTC timer run is checked next.

- 2026-11-05: **M7 data check (C, read-only with `prod-query.mjs`)** after K's audit on Azure. Audit job `done`, no error; report: 4 listings read, 4 priced (2 proposed, 1 needs K's answer), 2 sold and 0 unsold in 60 days, 23 sales, 14 answered questions and 32 sent messages, style learned from 25 replies (39 on 2026-11-03: style guide v2 learns from pre-sale replies only), private seller, no business policies, 0 policy fixes. Proposals: 4 agreed, 7 rejected, 4 pending, 1 expired, all dry runs (baseline 3 pending: one expired, the audit added 2 price proposals); `audit_log` has no applied entries. TV stand floor £55 and its facts intact. Specs for 4 listings; price decisions 8 (4 new), latest 4; bundle advice 1; 23 orders. Sold-data usage unchanged (Trawl 29, CompsAPI 31: the audit priced from the 30-day cache). Claude: 15 calls today, $0.024; 98 calls in all (83 imported). `writes_paused` = 1. People: K only, passkeys "Android phone" and "Windows computer"; the re-enrolment invite used; 10 recovery codes, all from the Windows passkey (00:50 UTC), so the Cloudflare and phone sets are gone; 2 push devices. The 15-minute poll runs on Azure (01:00, no errors). Next: the 02:00 UTC nightly.

- 2026-11-05: **M6 complete.** `check-production.mjs` passed on production (K), all 25 checks. Next: M7, K runs the first-day audit on Azure.

- 2026-11-05: First `check-production.mjs` on production (K): A6, B1, B2, B7, B8, the HTTPS redirect and /admin passed, then the script crashed: on Windows `az()` ran az.cmd through cmd.exe with unquoted arguments (also the DEP0190 warning), so a JMESPath query with spaces was split. It had only run on Linux before. `azure-common.mjs` now double-quotes each argument into one command line and refuses `"`, `%` or newlines (secrets never go through az arguments: Key Vault reads them from a file). The site check then read nulls: on Flex with az 2.92 `functionapp show` leaves siteConfig empty and puts httpsOnly under properties, so it now uses `functionapp config show`. The full check passes on Sandbox. K uninstalled the old workers.dev app from the phone.

- 2026-11-05: eBay portal pointed at Azure (RuName accept URL, privacy URL, account-deletion endpoint); C6 passed on Azure. K re-enrolled with a new passkey, saved the recovery codes, installed the app and received a test notification.

- 2026-11-04: **M5 complete.** Production redeployed with the Node-built zip: sign-in page loads, `/health` production/off, `/admin` 401, `/mcp` 404. Next: M6 switch-over, when K is ready.
- 2026-11-04: M5 deployed by K. Public checks from the cloud session: HSTS, CSP, nosniff, X-Frame-Options DENY; `/admin` 401; `/mcp` 404; `/api/me` 401 when signed out. The dashboard page answered 500: the deploy zip was made with PowerShell's Compress-Archive, which writes `web\index.html` (backslashes), a file name rather than a folder on the Linux host. `azure-deploy.mjs` now builds the zip in Node (`scripts/make-zip.mjs`; a first fix using `tar.exe` failed on K's PC, where `tar` is GNU tar) and refuses a zip with backslash paths or without `index.js` and `web/index.html`.
- 2026-11-04: **M4 complete.** The cloud session signed out of Azure (`az logout`). Next: M5, K deploys production (read-only).
- 2026-11-04: More M4 checks passed: push to the installed app (K); first-day audit as a background job (report saved, no failed steps); nightly run (snapshots refreshed); a second approved price change applied (item 110591497965, £12 → £10.80, Ack Success). Claude spend for all Sandbox checks: $0.14. Cosmos peaked at 100% normalised RU only during the import (02:09), 32–41% otherwise, no throttling (429). Its 400s are the gateway's documented first-chance reply to sorted cross-partition queries, which the SDK retries with a query plan. Application Insights: no app exceptions, only the Functions host's own storage-probe 404/409s and one restart.
- 2026-11-04: M4 checks on Sandbox. Passed: passkey registration via `/api/setup`, eBay sign-in with the new RuName, the 15-minute timer, a price check as a background job, and an **approved price change applied** (`ReviseFixedPriceItem` The Hobbit £4.50 → £4.05, Ack Success, audit_log `applied`, actor K). Found and fixed: the ntfy fallback sent the title as a header, and Node refuses '→' and '£' in headers, so every price proposal threw after being saved (Claude retried, each retry superseding the last); ntfy is now published as JSON and can't fail the caller. To fix later: a price check with no matches reads "about ? today".
- 2026-11-04: Client address fixed: `clientIp()` reads `Client-IP` (port stripped), tests updated, temporary diagnostic removed. The sign-in page has no key form: on Sandbox, key sign-in is API-only, so K registers a Sandbox passkey via `/api/setup` (a rehearsal of M6's re-enrolment).
- 2026-11-04: Sandbox import (K) verified: 63 documents, metrics match; no re-enrolment link because the only Sandbox user is the test user. Forged `X-Client-IP` test FAILED: failed sign-ins were recorded under `203.0.113.77` and `198.51.100.9` as sent, and as `unknown` with no header. Work on the per-network limit stopped for K's decision.
- 2026-11-04: Sandbox deployed to Azure from the cloud session. First deploy failed: Cosmos rejects `/id/?` as an index path (id is a system property, always indexed) and `auth` listed `/user_id/?` twice; both removed, with a test. `/health` 200 (sandbox, approval); HSTS, X-Frame-Options DENY, nosniff and CSP present; `/admin/host/status` 401; HTTPS only, TLS 1.2, FTP off, no CORS.
- 2026-11-04: Production dry run (K): 246 documents, every table and the sampled documents matched; the one failure was a false alarm (proposal counts in a different key order). The metrics check now sorts object keys before comparing.
- 2026-11-04: K merged the Phase 7 pull request and chose France Central (the UK and West/North Europe regions aren't allowed by the Students policy). Defaults switched from `uksouth` to `francecentral`.
- 2026-11-03: plan approved; branch and this doc created.
- 2026-11-04: M3 written. The importer dry run on the Sandbox export matched (a float rounding difference in summed costs was a false alarm; the check now compares to 1e-9). Template validation waits for the Azure CLI.
- 2026-11-04: M2 done: 209 tests pass (1 skipped). The function package builds (`npm run build:azure`); it is first run for real on Sandbox at M4.
- 2026-11-04: M1 done. All 25 modules moved to the store; 201 tests pass (1 skipped: the emulator suite). Found and fixed on the way: a date bug in the audit's "days listed" (it used the wall clock), and supersede retries too short under 6 simultaneous creates (now 25 with back-off). Two claims made atomic that weren't before: recovery codes and sign-in challenges.
