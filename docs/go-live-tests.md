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

- [x] B1. (R) Every `/api` route returns 401 without a session, including with a forged or expired cookie.
- [x] B2. (R) State-changing requests without the `X-EbayManager` header return 403.
- [x] B3. (R) A manager session gets 403 on owner-only actions (invite, remove user, resume, auto-apply settings, connect eBay). (2026-11-05, C: security.test "keeps owner-only actions from managers", including Inbox answers and price actions)
- [x] B4. (R) A fourth user can't be added. (2026-11-05, C: security.test "allows three people at most")
- [x] B5. (R) An invite link works once and expires after 24 hours. (2026-11-05, C: single use tested at setup; 24-hour expiry test added)
- [x] B6. (R) Sign-in is rate-limited after 5 failures. (2026-11-05, C: security.test, 5 failed passkey sign-ins per person in 15 minutes, 20 per network per hour)
- [x] B7. (R) `/mcp` returns 404 in production; `/oauth/start` without the owner's session returns 401.
- [x] B8. (R) Security headers are present on every page (CSP, no framing, nosniff, no referrer), and cookies are `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`.
- [x] B9. (R) The production decide link is refused without a signed-in session, even when correctly signed. (2026-11-05, C: security.test "needs a signed-in device for a production approval link, even when it is correctly signed")
- [x] B10. (K) K registers a passkey on their phone and on a computer, and signs in on both. (2026-11-05, K: "Android phone" and "Windows computer" on Azure production)
- [ ] B11. (K) Each manager registers through their invite, signs in on their own phone, and turns on notifications. **N/A until a manager joins** (K's decision, 2026-11-05: go live with K only; run this the day the first manager is invited)
- [ ] B12. (K) K signs one manager out of all devices from Settings, and that manager has to sign in again. **N/A until a manager joins** (K's decision, 2026-11-05: go live with K only; run this the day the first manager is invited)
- [ ] B13. (K) Each person stores their recovery codes, and one code is tested once, then a new passkey is registered. (K now; each manager when they join)
- [ ] B14. (K, optional) An identity gate in front of the app (on Azure: App Service authentication with Entra ID, replacing the Cloudflare Access idea) admits the three people and turns a fourth away. Not set up; passkeys are the gate.

## C. eBay connection, read-only (R and K)

- [ ] C1. (K) K signs in to the **real** eBay account through the production app. The page says "eBay production connected · Scopes: read-only".
- [ ] C2. (R) The stored scopes are all `.readonly`.
- [ ] C3. (R) The listings in the app match Seller Hub: count, titles, prices, quantities. Spot-check 5 listings field by field.
- [ ] C4. (R) Orders for the last 90 days match Seller Hub's count and totals.
- [ ] C5. (R) Business policies read correctly (postage, returns, payment).
- [x] C6. (R) The marketplace account deletion endpoint answers eBay's challenge, and a signed test notification deletes the test user's data. (2026-11-05, K: verified in the eBay portal with a successful test notification; `check-production.mjs` C6 passes)
- [ ] C7. (R) eBay API call volume over the cycle is well within the daily limits.

## D. Nothing can change on the real account (R)

- [ ] D1. Every proposal created in production is marked dry run. Approving one records it as "Approved (dry run)" and sends nothing; rejecting one works as usual.
- [ ] D2. A forced attempt to apply a production proposal through the gate is refused ("Writes are off") and logged as refused.
- [ ] D3. The Trading client refuses a write verb in production.
- [ ] D4. The Activity log shows **no** applied entries for production.
- [ ] D5. In Seller Hub, no listing's "last revised" time changed during the cycle (K confirms in C3's spot check).

## E. First-day audit (R and K)

- [ ] E1. (R) The audit report covers every active listing, the sold history, ended listings, messages and settings.
- [ ] E2. (K) K goes through the audit's to-dos in the Inbox (since 2026-11-05 they replace the findings list) and agrees with them, or notes where one is wrong.
- [ ] E3. (K) K reads the reply style guide (now in Settings) and corrects anything that doesn't sound like them.

## F. Proposals, as dry runs (K)

- [ ] F1. At least 10 dry-run proposals reviewed (titles, specifics, descriptions, prices): each makes sense, uses only true facts, and shows its evidence.
- [ ] F2. Every price proposal has a market picture: comparables with links, the condition match, saturation, postage-inclusive prices, and profit after fees above the floor.
- [ ] F3. No proposal invents a fact (K checks 5 against the real item).
- [ ] F4. Floor prices are set for the items that need them.

## G. Messages and offers, as dry runs (R and K)

- [ ] G1. (R) The 15-minute poll runs through the cycle without errors.
- [ ] G2. (K) Any real buyer question that arrived got a dry-run draft. K judges the drafts: accurate, in K's style, nothing promised. If none arrived, a manager's personal eBay account asks a question on one of K's listings (real, but harmless: nothing can be sent back).
- [ ] G3. (K) Any real offer got a sensible suggestion that respects the floor.

## H. Notifications and the app (K)

- [ ] H1. A test push arrives on K's phone as a pop-up. On the managers' phones: **N/A until a manager joins** (K's decision, 2026-11-05: go live with K only; run this the day the first manager is invited)
- [ ] H2. A dry-run proposal's notification shows "Dry run" and has no Approve button.
- [ ] H3. The app works on a phone and on a computer: Inbox, Listings, Metrics, Activity, Settings.
- [ ] H4. K can pause and resume all changes. That a manager can pause but not resume is covered by the tests (B3); on a manager's phone: **N/A until a manager joins** (K's decision, 2026-11-05: go live with K only; run this the day the first manager is invited)

## I. Switching on (K, then R)

- [ ] I1. K signs in to eBay again through the production app, this time granting full permissions.
- [ ] I2. `WRITE_MODE` set to `approval` and deployed (R). Production proposals created from now on are real.
- [ ] I3. The first change is something small and reversible (a typo fix in one title). K approves it, then checks it on eBay.
- [ ] I4. The first 10 changes are made one at a time, each checked on eBay before the next.
- [ ] I5. One price change and one offer answer are watched end to end.
