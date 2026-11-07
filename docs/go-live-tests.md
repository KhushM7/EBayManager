# Go-live tests

The real account runs read-only for **one nightly cycle at most** (connect during the day, let the 02:00 run complete, test, go live the next day). Instead of a long wait, every item below must pass before `WRITE_MODE` is switched to `approval` in production.

**(R)** = run remotely (automated test or a check run from the terminal, with the output recorded here). **(K)** = K, or a manager, does it physically on a phone or computer. Tick each with the date and who checked it.

Since 2026-11-05 production runs on Azure (docs/azure-migration.md): Cosmos DB and Blob Storage replace D1 and R2, and `node scripts/check-production.mjs` runs A6, B1, B2, B7, B8, C6 and the Azure settings in one go. K goes live as the only user; the items that need a manager are marked N/A and are run when one joins.

## A. Code and build (R)

- [x] A1. `npm run typecheck && npm test` pass on the exact commit being deployed. (2026-11-05, C: typecheck and 244 tests pass on 216fcaa, the deployed code. Re-run on the commit K deploys before switching on)
- [x] A2. `npm audit --omit=dev` shows no high or critical issues. (2026-11-05, C: npm audit --omit=dev, 0 vulnerabilities)
- [x] A3. Write-gate tests pass: every refusal path (writes off, paused, pending, rejected, expired, dry run, already applied, empty reply, unbuilt kind, title lock). (2026-11-05, C: test/gate.test.ts, 20 tests, every refusal path)
- [x] A4. Source scans pass: write calls only in `src/ebay/write.ts`, network calls only in reviewed modules, hosts only in `hosts.ts`, eBay calls only from the allowlist. (2026-11-05, C: test/safety.test.ts, 10 tests)
- [x] A5. A deliberate stray write call in a scratch file makes the scan fail (then the file is removed). (2026-11-05, C: a scratch file with a ReviseFixedPriceItem call to api.ebay.com failed 3 scans (write call named, unreviewed network call, eBay host outside hosts.ts); removed, suite green)
- [x] A6. The production config has `EBAY_ENV=production` and `WRITE_MODE=off`, its own database (Cosmos `ebay-production`) and storage, `/mcp` off, and no Sandbox secrets. (2026-11-05, K: `check-production.mjs`; the template forces these for production)

## B. Access and security (R and K)

Sign-in changed on 2026-11-07 from passkeys to email and authenticator code, with a hidden site ([security.md](security.md)). B1 to B6 and B10 to B14 were rewritten for it. Their earlier passkey ticks (2026-11-05) are history and must be redone on the new build.

- [ ] B1. (R) The hidden site: without a session, every address (`/`, `/api/*`, `/health`, `/oauth/start`, a wrong sign-in address) is an empty 404, including with a forged cookie. (C, 2026-11-07: security.test "the hidden site", 4 tests. On each environment: `check-production.mjs`)
- [ ] B2. (R) State-changing requests without the `X-EbayManager` header, or from another origin, are refused. The sign-in form refuses a POST from another site. (C, 2026-11-07: security.test. On each environment: `check-production.mjs`)
- [x] B3. (R) A manager session gets 403 on owner-only actions (see people, sign others out, resume, auto-apply settings, connect eBay, Inbox answers, price actions). (2026-11-07, C: security.test "keeps owner-only actions from managers", "the owner can sign anyone out everywhere; a manager only themselves")
- [x] B4. (R) The people list allows 1 to 3 people with exactly one owner and full-length secrets; a malformed list lets nobody in; there's no way to add people from the app. (2026-11-07, C: security.test "checks the people list strictly", "lets nobody in when the people list is missing or malformed", "has no way to add or change people from the app")
- [x] B5. (R) Each authenticator code works once (and never an older one after a newer one). A wrong code and an unknown email get the same answer. Taking someone off the list ends their sessions. (2026-11-07, C: security.test "signing in")
- [x] B6. (R) Sign-in is rate-limited: 5 failures per person in 15 minutes (from any network), 20 per network per hour. (2026-11-07, C: security.test)
- [ ] B7. (R) `/mcp` is a blank 404 in production; `/oauth/start` without the owner's session is a blank 404; the key sign-in never works in production. (C, 2026-11-07: security.test. On production: `check-production.mjs`)
- [x] B8. (R) Security headers are present on every page (CSP, no framing, nosniff, no referrer, noindex), and cookies are `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax` (Strict until 2026-11-07; see security.md).
- [x] B9. (R) The production decide link is refused without a signed-in session, even when correctly signed. (2026-11-05, C: security.test "needs a signed-in device for a production approval link, even when it is correctly signed"; still passing 2026-11-07)
- [ ] B10. (K) K runs `people.mjs production add` for themselves and scans the QR code. They sign in on the phone (installed app, "stay signed in" ticked) and on a computer (unticked), turn on notifications on the phone, and see the Settings → People list.
- [ ] B11. (K) Each manager is added with `people.mjs`, scans their QR code, signs in on their own phone and turns on notifications. **N/A until a manager joins** (K's decision, 2026-11-05: go live with K only)
- [ ] B12. (K) K signs one manager out of all devices from Settings, and that manager has to sign in again. **N/A until a manager joins**
- [ ] B13. (K) Recovery: K runs `people.mjs production new-code` for themselves, the old authenticator entry stops working and the new one signs in. K also checks the authenticator app's cloud backup is on.
- [ ] B14. (K) The hidden site from outside: in a private window (or on mobile data), the app's address and `/api/me` show a blank page, and only the bookmarked sign-in address shows the sign-in form. After signing out, the installed app opens straight to the sign-in page.

## C. eBay connection, read-only (R and K)

- [ ] C1. (K) K signs in to the **real** eBay account through the production app. The page says "eBay production connected · Scopes: read-only".
- [x] C2. (R) The stored scopes are all `.readonly`. (2026-11-07, C: production `ebay_tokens` holds `api_scope` plus the `.readonly` scopes for inventory, marketing, account, fulfillment and analytics, nothing else)
- [ ] C3. (R) The listings in the app match Seller Hub: count, titles, prices, quantities. Spot-check 5 listings field by field.
- [ ] C4. (R) Orders for the last 90 days match Seller Hub's count and totals. (2026-11-07, C: the app has 2 orders in the last 90 days, 25 Sep £7.37 and 27 Sep £32.97, £40.34 in all, both fulfilled; 23 orders overall with the imported history. **K:** confirm Seller Hub shows the same)
- [x] C5. (R) Business policies read correctly (postage, returns, payment). (2026-11-07, C: the account doesn't use business policies, which the audit detected; it checked each listing's own returns and postage instead, and its findings cover them)
- [x] C6. (R) The marketplace account deletion endpoint answers eBay's challenge, and a signed test notification deletes the test user's data. (2026-11-05, K: verified in the eBay portal with a successful test notification; `check-production.mjs` C6 passes)
- [ ] C7. (R) eBay API call volume over the cycle is well within the daily limits. (2026-11-07, C: the app doesn't count its eBay calls. Estimate: the 15-minute poll is about 3 calls, so roughly 300 a day, plus a nightly run of a few dozen, against Trading's 5,000 a day. **K:** confirm in the eBay developer portal under Application Keys → API call usage)

## D. Nothing can change on the real account (R)

- [x] D1. Every proposal created in production is marked dry run. Approving one records it as "Approved (dry run)" and sends nothing; rejecting one works as usual. (2026-11-07, C: all 25 production proposals have `dry_run = 1`; 17 approved as dry runs ("agreed"), others rejected or expired)
- [x] D2. A forced attempt to apply a production proposal through the gate is refused ("Writes are off") and logged as refused. (2026-11-07, C: test/gate.test.ts "refuses everything when WRITE_MODE is off, even an approved proposal"; production runs `WRITE_MODE=off`, check-production A6)
- [x] D3. The Trading client refuses a write verb in production. (2026-11-07, C: test/gate.test.ts "the read client refuses write verbs before calling eBay")
- [x] D4. The Activity log shows **no** applied entries for production. (2026-11-07, C: the production audit log is empty: nothing applied, nothing even attempted)
- [ ] D5. In Seller Hub, no listing's "last revised" time changed during the cycle (K confirms in C3's spot check).

## E. First-day audit (R and K)

- [x] E1. (R) The audit report covers every active listing, the sold history, ended listings, messages and settings. (2026-11-07, C: the latest first-day report covers the 4 active listings, sold history, ended listings (0), messages and reply style, settings (policies), with 13 findings)
- [ ] E2. (K) K goes through the audit's to-dos in the Inbox (since 2026-11-05 they replace the findings list) and agrees with them, or notes where one is wrong.
- [ ] E3. (K) K reads the reply style guide (now in Settings) and corrects anything that doesn't sound like them.

## F. Proposals, as dry runs (K)

- [ ] F1. At least 10 dry-run proposals reviewed (titles, specifics, descriptions, prices): each makes sense, uses only true facts, and shows its evidence.
- [ ] F2. Every price proposal has a market picture: comparables with links, the condition match, saturation, postage-inclusive prices, and profit after fees above the floor.
- [ ] F3. No proposal invents a fact (K checks 5 against the real item).
- [ ] F4. Floor prices are set for the items that need them.

## G. Messages and offers, as dry runs (R and K)

- [ ] G1. (R) The 15-minute poll runs through the cycle without errors. (2026-11-07, C: the latest poll had no errors, 0 questions and 0 offers. The app keeps only the latest poll's result, so re-check tomorrow after a full night; a manual nightly at 03:45 UTC ran every step clean)
- [ ] G2. (K) Any real buyer question that arrived got a dry-run draft. K judges the drafts: accurate, in K's style, nothing promised. If none arrived, a manager's personal eBay account asks a question on one of K's listings (real, but harmless: nothing can be sent back).
- [ ] G3. (K) Any real offer got a sensible suggestion that respects the floor.

## H. Notifications and the app (K)

- [ ] H1. A test push arrives on K's phone as a pop-up. On the managers' phones: **N/A until a manager joins** (K's decision, 2026-11-05: go live with K only; run this the day the first manager is invited)
- [ ] H2. A dry-run proposal's notification shows "Dry run" and has no Approve button.
- [ ] H3. The app works on a phone and on a computer: Inbox, Listings, Metrics, Activity, Settings.
- [ ] H4. K can pause and resume all changes. That a manager can pause but not resume is covered by the tests (B3); on a manager's phone: **N/A until a manager joins** (K's decision, 2026-11-05: go live with K only; run this the day the first manager is invited)

## I. Switching on (K, then R)

2026-11-07: K reported that every remaining (K) item in sections B to H passes, including C4 and C7 (orders match Seller Hub, call volume within limits). C prepared the switch: `writeMode = 'approval'` in `infra/production.bicepparam`, the production override removed from `infra/main.bicep`, A1 re-run (typecheck, 319 tests, `npm audit --omit=dev` 0 vulnerabilities). From go-live, dry runs left over from the read-only days no longer hold a listing, so the first nightly run makes fresh, real suggestions; real ones still hold for 7 days, so nothing repeats (`holdsListing` in src/proposals.ts).

- [ ] I1. K signs in to eBay again through the production app, this time granting full permissions.
- [ ] I2. `WRITE_MODE` set to `approval` and deployed (R). Production proposals created from now on are real. (2026-11-07, C: change prepared; K deploys it, then `check-production.mjs` shows `writeMode: approval`)
- [ ] I3. The first change is something small and reversible (a typo fix in one title). K approves it, then checks it on eBay.
- [ ] I4. The first 10 changes are made one at a time, each checked on eBay before the next.
- [ ] I5. One price change and one offer answer are watched end to end.
