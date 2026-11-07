# Security

Three named people can use the app: K (the owner) and two managers. Each signs in with **their email and the 6-digit code from an authenticator app** (Google or Microsoft Authenticator). Only K decides who they are, on their own computer; the app has no way to add anyone. The site is **hidden**: to anyone not signed in, every address is a blank "Not found", except a sign-in page at a secret address. Nobody else can see any account data or change anything, wherever they are.

Decided 2026-11-02 (with passkeys); changed by K on 2026-11-07 to email and authenticator code, a fixed list of people set by script, and a hidden site. Passkeys were awkward on laptops without fingerprint or face sign-in, and invites and recovery codes were unnecessary for three known people.

## Who can do what

| Action | Owner (K) | Manager (2 people) |
| --- | --- | --- |
| See listings, metrics, activity, drafts | Yes | Yes |
| Approve, reject or edit proposals | Yes | Yes |
| Pause all changes | Yes | Yes |
| Resume changes, change auto-apply settings | Yes | No |
| See who can sign in, sign anyone out everywhere, connect eBay | Yes | No (only sign themselves out) |
| Add, change or remove people | Not in the app: K only, with `scripts/people.mjs` | No |

The limit of three people, with exactly one owner, is enforced in code. Every approval, rejection, edit and setting change records who made it, and the Activity screen shows it.

## Signing in

1. **K sets up a person** on their computer: `node scripts/people.mjs <sandbox|production> add --email … --name … --role owner|manager`. The script:
   - makes a fresh authenticator secret and shows it once as a QR code in the terminal;
   - saves the list (`PEOPLE`) in the gitignored `.dev.vars` or `.prod.vars`;
   - uploads it to the environment's Key Vault and restarts the app.

   The first run also makes the secret sign-in address (`SIGNIN_PATH`).
2. **The person scans the QR code** into Google or Microsoft Authenticator (or types the setup key). They bookmark the sign-in address, which K sends them privately.
3. **Signing in**, on any phone or computer: open the sign-in address, then enter the email and the current 6-digit code. It's a plain server page with no script.
   - Only the listed emails are accepted. An unknown email and a wrong code get the same answer, so nobody can test which emails work.
   - Each code works once. A code seen over someone's shoulder can't be reused, and neither can an older one after a newer one.
   - Codes from one step either side of now are accepted, for a phone clock a little out.
4. **Sessions:** a normal sign-in lasts 12 hours of inactivity, or 7 days at most. Sessions are stored server-side, so K can sign anyone out of every device at once.
   - "Stay signed in on this device for 30 days" is ticked by default; untick it on a shared computer.
   - It keeps the installed phone app signed in, so notification approvals keep working.
5. **A lost or new phone:** the authenticator app's own cloud backup restores the codes. Otherwise K runs `people.mjs … new-code --email …`, which gives a new QR code; the old authenticator stops working. Removing a person (`… remove --email …`) ends their sessions at once.
6. **Other commands:** `change-email` fixes a typo and keeps the same authenticator entry. `new-link` makes a fresh sign-in address if the old one was shared, and the old one then shows a blank page. `refresh` makes every running copy of the app re-read Key Vault: Azure caches its values for up to 24 hours, which once left the sign-in page loading only on some tries (2026-11-07). Every command that uploads does this refresh, restarts the app and checks the page loads every time.

`DASHBOARD_KEY` signs in as a test owner only on Sandbox (`ALLOW_KEY_LOGIN`), for scripts and checks, never in production. On production it only reads `/health` (`X-Health-Key`).

**Why not passkeys:** passkeys are the strongest sign-in because they can't be phished, and the app used them from Phase 6 to 2026-11-07. K chose email and code so there is one way in that works the same on every device.
- **The trade-off:** the code is one real factor (the phone), and a convincing fake of the sign-in page could relay a code within its 30 seconds.
- **What limits that risk:** the hidden site, single-use codes, rate limits, the approval-only write gate and the audit log. A stolen sign-in could only approve labels, never make other eBay changes.

## The hidden site

To anyone without a session, every address returns an empty 404, with no app, logo or sign-in form. That covers `/`, `/api/*`, `/health`, `/oauth/*`, made-up approval links and the old `/login`. Search engines are told not to index anything (`X-Robots-Tag`).

Only these answer:
- the sign-in page at `/s/<SIGNIN_PATH>` (at least 16 random characters; a shorter value turns it off);
- `/ebay/account-deletion`, which eBay calls;
- `/privacy.html`, which eBay's developer settings link to;
- the app icons and the service worker script (`/sw.js`), because browsers fetch them without cookies when installing the app and showing notifications. They hold no data and no app name. The manifest stays private: the page asks for it with the session cookie (`crossorigin="use-credentials"`), so "Install app" works only once signed in;
- `/health` with K's `X-Health-Key`, for `scripts/check-production.mjs`.

The secret address only hides the site: the email and code are the security.

**Known devices:** a browser where someone has signed in carries a signed "known device" mark (`__Host-known`, kept 400 days). It isn't a sign-in. It only sends that browser to the sign-in page when its session has ended, so the installed app still opens.

A missing or malformed people list lets nobody in.

## Approving from a notification

On the real account, the Approve and Reject buttons on a notification need **both**:
- the signed link in the notification;
- the signed-in session of the device that received it.

A forwarded or screenshotted link is useless on another device, and a phone whose session has expired must sign in first. Replies to buyers and accepting offers can additionally be set to "open the app to approve" in Settings. That is on by default for the real account.

## Layers, outside in

| Layer | What it stops |
| --- | --- |
| 1. The hidden site | Anyone without the secret sign-in address: they see only blank "Not found" pages, with nothing to probe or recognise |
| 2. Email and authenticator code, per person | Everyone else: only the three listed emails, each code once, rate-limited |
| 3. Roles | Managers can't resume changes, switch on auto-apply, connect eBay or sign others out. Nobody can add people from the app |
| 4. The write gate | Any eBay change that isn't an approved proposal, whoever is signed in |
| 5. The eBay call allowlist | Any eBay call not on the explicit list below, even from the app's own code |
| 6. Audit log | Nothing happens without a record of who and when |

## Production hardening

- **`/mcp` is off in production.** The Claude connector stays available on Sandbox only, unless K switches it on deliberately.
- **Connecting eBay** (`/oauth/start`) needs the owner's signed-in session, not a token in the URL.
- **Login protection:** after at most 5 failed sign-ins per person (or per unknown email) per 15 minutes, or 20 per hour from any one network, there's a pause. Each authenticator code works once. The sign-in form only accepts a POST from its own page (checked with `Sec-Fetch-Site` or `Origin`).
- **People and their authenticator secrets** live only in Key Vault (`PEOPLE`) and K's gitignored vars file. The app reads them, never writes them, and never sends a secret to a browser.
- **Headers:** a strict content security policy (only the app's own code and its font), no framing, no referrer, and HTTPS only. Cookies are `__Host-`, `HttpOnly`, `Secure` and `SameSite=Lax`.
  - The session cookie was `Strict` until 2026-11-07, when K approved the change. Under `Strict` the installed phone app asked for a sign-in on every launch: an app opened from the home screen counts as arriving from outside, and `Strict` cookies aren't sent then.
  - `Lax` is sent from elsewhere only on top-level GETs, which change nothing.
- **CSRF:** every change needs the `X-EbayManager` header and a same-origin request.
- **Secrets** live only in each environment's Key Vault (read by the app's managed identity, never as plain app settings) and in K's gitignored `.dev.vars` and `.prod.vars`. They are never in code, logs, notifications or chat. The eBay token is stored in Cosmos DB and never sent to the browser.
- **Azure:** HTTPS only, TLS 1.2, FTP and basic-auth publishing off, no CORS, the Functions host's `/admin` endpoints closed, Cosmos DB key access disabled (Entra ID only). K's own login has only Data Reader on production data. The client address for rate limits comes only from `Client-IP`, which the front end overwrites (other headers can be forged). `check-production.mjs` checks all of these.
- **Buyer data:** the app keeps only what it needs (buyer usernames and question text for drafting replies, order totals and item IDs) and deletes a buyer's data when eBay sends a marketplace account deletion notification. Addresses are never stored.
- **Dependencies:** few, pinned in `package-lock.json`, checked with `npm audit` before each production deploy.

## eBay calls the app may make

Everything else is refused in code (`src/ebay/allowlist.ts`), and a test fails if any file calls eBay outside it.

| Kind | Calls |
| --- | --- |
| Read | Trading `GetMyeBaySelling`, `GetItem`, `GetMemberMessages`, `GetMyMessages`, `GetBestOffers`, `GetUser`; Fulfillment `getOrders`; Analytics `getTrafficReport`; Account `get*Policies`; Browse `search`, `getItem`; Taxonomy `getCategorySuggestions`, `getItemAspectsForCategory`; Marketing `getCampaigns`, `getAds`; Recommendation `findListingRecommendations` (a read sent as POST; eBay requires the full `sell.inventory` scope for it, so it works only after go-live); Notification `getPublicKey` |
| Check without changing | Trading `VerifyAddFixedPriceItem` |
| Write, only through the gate after approval | Trading `ReviseFixedPriceItem`, `AddFixedPriceItem`, `EndFixedPriceItem`, `RelistFixedPriceItem`, `AddMemberMessageRTQ`, `RespondToBestOffer`, `UploadSiteHostedPictures` (a new listing's photos, sent as bytes while applying its approved `create_listing` label, each upload audited; added 2026-11-05 with Add Listing); Marketing `createCampaign`, `bulkCreateAdsByListingId`, `bulkUpdateAdsBidByListingId` |
| Never | Anything that changes account settings, payments, payouts, addresses, feedback, cancellations, refunds or other users |

**Outside eBay**, the Worker may call only: Anthropic (Claude, including Anthropic's server-side web search used to look up published product specifications in `src/specs.ts`: the searching happens on Anthropic's side, and the only tool Claude has there records specs, which the code keeps only if their source page came from that search), the Web Push services, ntfy, the two sold-data providers `api.trawl.dev` and `api.compsapi.com` (search words only, hard monthly caps, `src/solddata.ts`), and Parcel2Go (`www.parcel2go.com` or its sandbox) for postage quotes on new listings (`src/postage.ts`: a parcel's size, weight and value only, never an address; credentials in Key Vault). A test fails if any other module makes network calls.

**Listing photos** (Add Listing, 2026-11-05) live in the private `photos` Blob container (no public access) and are served only to a signed-in person. Their location data is removed on the phone (re-encoding) and again on the server (metadata segments stripped). Claude receives them as image data and eBay as uploaded bytes, so they never get a public address. An abandoned draft's photos are deleted after 30 days, a published listing's 30 days after it went live.

## Threats and answers

| Threat | Answer |
| --- | --- |
| Someone finds the web address | They see a blank page everywhere. Even with the sign-in address, they need one of the three emails and that person's current code |
| A manager's phone is stolen | It's locked by its own PIN. K signs them out everywhere and runs `people.mjs new-code` (or `remove`) |
| A phishing page copies the sign-in | The address is secret, so a lookalike would have to target one of the three. A relayed code works once, within about 30 seconds, and could only approve labels, each recorded in the audit log |
| Someone guesses codes | 5 tries per person per 15 minutes and 20 per network per hour, against a million possible codes |
| An approval link leaks | It also needs the receiving device's session, and it expires after 7 days |
| Someone brute-forces sign-in | There are no passwords to guess, and attempts are rate-limited |
| A cross-site request tries to approve something | Blocked: a cross-site POST carries no `SameSite=Lax` session, so the real account refuses it; API changes need the custom header and a same-origin request; the sign-in form checks its origin |
| A bug tries an eBay call it shouldn't | The allowlist refuses it; the write gate refuses unapproved changes |
| Claude is tricked by text in a buyer message | Claude can only draft. Its tools can't change eBay, and every draft needs a person's approval |
| The Azure account or a secret is compromised | K revokes the app in eBay's account settings, which cuts access instantly, then rotates secrets |
