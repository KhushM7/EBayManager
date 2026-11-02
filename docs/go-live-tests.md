# Go-live tests

The real account runs read-only for **one nightly cycle at most** (connect during the day, let the 02:00 run complete, test, go live the next day). Instead of a long wait, every item below must pass before `WRITE_MODE` is switched to `approval` in production.

**(R)** = run remotely (automated test or a check run from the terminal, with the output recorded here). **(K)** = K, or a manager, does it physically on a phone or computer. Tick each with the date and who checked it.

## A. Code and build (R)

- [ ] A1. `npm run typecheck && npm test` pass on the exact commit being deployed.
- [ ] A2. `npm audit --omit=dev` shows no high or critical issues.
- [ ] A3. Write-gate tests pass: every refusal path (writes off, paused, pending, rejected, expired, dry run, already applied, empty reply, unbuilt kind, title lock).
- [ ] A4. Source scans pass: write calls only in `src/ebay/write.ts`, network calls only in reviewed modules, hosts only in `hosts.ts`, eBay calls only from the allowlist.
- [ ] A5. A deliberate stray write call in a scratch file makes the scan fail (then the file is removed).
- [ ] A6. The production config has `EBAY_ENV=production` and `WRITE_MODE=off`, its own D1 and R2, `/mcp` off, and no Sandbox secrets.

## B. Access and security (R and K)

- [ ] B1. (R) Every `/api` route returns 401 without a session, including with a forged or expired cookie.
- [ ] B2. (R) State-changing requests without the `X-EbayManager` header return 403.
- [ ] B3. (R) A manager session gets 403 on owner-only actions (invite, remove user, resume, auto-apply settings, connect eBay).
- [ ] B4. (R) A fourth user can't be added.
- [ ] B5. (R) An invite link works once and expires after 24 hours.
- [ ] B6. (R) Sign-in is rate-limited after 5 failures.
- [ ] B7. (R) `/mcp` returns 404 in production; `/oauth/start` without the owner's session returns 401.
- [ ] B8. (R) Security headers are present on every page (CSP, no framing, nosniff, no referrer), and cookies are `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`.
- [ ] B9. (R) The production decide link is refused without a signed-in session, even when correctly signed.
- [ ] B10. (K) K registers a passkey on their phone and on a computer, and signs in on both.
- [ ] B11. (K) Each manager registers through their invite, signs in on their own phone, and turns on notifications.
- [ ] B12. (K) K signs one manager out of all devices from Settings, and that manager has to sign in again.
- [ ] B13. (K) Each person stores their recovery codes, and one code is tested once, then a new passkey is registered.
- [ ] B14. (K, optional) Cloudflare Access is on for the three emails, and a fourth email is turned away.

## C. eBay connection, read-only (R and K)

- [ ] C1. (K) K signs in to the **real** eBay account through the production app. The page says "eBay production connected · Scopes: read-only".
- [ ] C2. (R) The stored scopes are all `.readonly`.
- [ ] C3. (R) The listings in the app match Seller Hub: count, titles, prices, quantities. Spot-check 5 listings field by field.
- [ ] C4. (R) Orders for the last 90 days match Seller Hub's count and totals.
- [ ] C5. (R) Business policies read correctly (postage, returns, payment).
- [ ] C6. (R) The marketplace account deletion endpoint answers eBay's challenge, and a signed test notification deletes the test user's data.
- [ ] C7. (R) eBay API call volume over the cycle is well within the daily limits.

## D. Nothing can change on the real account (R)

- [ ] D1. Every proposal created in production is marked dry run, and approving one returns "Dry run".
- [ ] D2. A forced attempt to apply a production proposal through the gate is refused ("Writes are off") and logged as refused.
- [ ] D3. The Trading client refuses a write verb in production.
- [ ] D4. The Activity log shows **no** applied entries for production.
- [ ] D5. In Seller Hub, no listing's "last revised" time changed during the cycle (K confirms in C3's spot check).

## E. First-day audit (R and K)

- [ ] E1. (R) The audit report covers every active listing, the sold history, ended listings, messages and settings.
- [ ] E2. (K) K reads the report and agrees with at least the top 10 findings (or notes where it's wrong).
- [ ] E3. (K) K reads the reply style guide and corrects anything that doesn't sound like them.

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

- [ ] H1. A test push arrives on all three people's phones, as a pop-up.
- [ ] H2. A dry-run proposal's notification shows "Dry run" and has no Approve button.
- [ ] H3. The app works on a phone and on a computer: Inbox, Listings, Metrics, Activity, Settings.
- [ ] H4. Pause all changes works for a manager; only K can resume.

## I. Switching on (K, then R)

- [ ] I1. K signs in to eBay again through the production app, this time granting full permissions.
- [ ] I2. `WRITE_MODE` set to `approval` and deployed (R). Production proposals created from now on are real.
- [ ] I3. The first change is something small and reversible (a typo fix in one title). K approves it, then checks it on eBay.
- [ ] I4. The first 10 changes are made one at a time, each checked on eBay before the next.
- [ ] I5. One price change and one offer answer are watched end to end.
