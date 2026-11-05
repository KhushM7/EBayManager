# Security

Three named people can use the app: K (the owner) and two managers. Each signs in with a **passkey**, a phishing-resistant key held on their phone or computer and unlocked by fingerprint, face or PIN. That counts as multi-factor authentication on its own: something you have (the device) plus something you are or know. Nobody else can see any account data or change anything, wherever they are.

Decided 2026-11-02. This must be built and tested before K's real account is connected (Phase 6).

## Who can do what

| Action | Owner (K) | Manager (2 people) |
| --- | --- | --- |
| See listings, metrics, activity, drafts | Yes | Yes |
| Approve, reject or edit proposals | Yes | Yes |
| Pause all changes | Yes | Yes |
| Resume changes, change auto-apply settings | Yes | No |
| Invite or remove users, connect eBay | Yes | No |

The limit of three users is enforced in code. Every approval, rejection, edit and setting change records who made it, and the Activity screen shows it.

## Signing in

1. **K adds a person:** in Settings, K enters their name and gets a single-use invite link valid for 24 hours. It's shown once and K sends it privately.
2. **The person registers a passkey** by opening the link on their phone or computer. The app accepts only passkeys that require user verification (fingerprint, face or device PIN). Passkeys sync through Google Password Manager or iCloud Keychain, so the same person can sign in from their other devices. They can also add another passkey for a device that doesn't sync.
3. **Recovery:** each person gets 10 one-time recovery codes at registration, shown once. A code signs them in once, then they must register a new passkey. K can also remove a lost device's passkey or a person entirely.
4. **Sessions:** a session lasts 12 hours of inactivity, or 7 days at most, then the person signs in again with their passkey. Sessions are stored server-side, so K can sign anyone out of every device at once.

The current single `DASHBOARD_KEY` sign-in is retired once passkeys work. Until then it stays only on Sandbox.

## Approving from a notification

On the real account, the Approve and Reject buttons on a notification need **both**:
- the signed link in the notification;
- the signed-in session of the device that received it.

A forwarded or screenshotted link is useless on another device, and a phone whose session has expired must sign in first. Replies to buyers and accepting offers can additionally be set to "open the app to approve" in Settings. That is on by default for the real account.

## Layers, outside in

| Layer | What it stops |
| --- | --- |
| 1. An identity gate (optional, not set up) | Would hide the whole site from anyone not among the three people before the app loads. On Azure this is App Service authentication with Entra ID (it replaced the Cloudflare Access idea at the move on 2026-11-05) |
| 2. Passkey sign-in, per person | Everyone else. Passkeys can't be phished or reused on another site |
| 3. Roles | Managers can't add users, resume changes or switch on auto-apply |
| 4. The write gate | Any eBay change that isn't an approved proposal, whoever is signed in |
| 5. The eBay call allowlist | Any eBay call not on the explicit list below, even from the app's own code |
| 6. Audit log | Nothing happens without a record of who and when |

## Production hardening

- **`/mcp` is off in production.** The Claude connector stays available on Sandbox only, unless K switches it on deliberately.
- **Connecting eBay** (`/oauth/start`) needs the owner's signed-in session, not a token in the URL.
- **Login protection:** at most 5 failed sign-ins per person per 15 minutes, and 20 per hour from any one network; then a pause. Invite links work once.
- **Headers:** a strict content security policy (only the app's own code and its font), no framing, no referrer, and HTTPS only. Cookies are `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`.
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
| Write, only through the gate after approval | Trading `ReviseFixedPriceItem`, `AddFixedPriceItem`, `EndFixedPriceItem`, `RelistFixedPriceItem`, `AddMemberMessageRTQ`, `RespondToBestOffer`; Marketing `createCampaign`, `bulkCreateAdsByListingId`, `bulkUpdateAdsBidByListingId`; Inventory and Media calls for publishing new listings (Phase 8) |
| Never | Anything that changes account settings, payments, payouts, addresses, feedback, cancellations, refunds or other users |

**Outside eBay**, the Worker may call only: Anthropic (Claude, including Anthropic's server-side web search used to look up published product specifications in `src/specs.ts`: the searching happens on Anthropic's side, and the only tool Claude has there records specs, which the code keeps only if their source page came from that search), the Web Push services, ntfy, and the two sold-data providers `api.trawl.dev` and `api.compsapi.com` (search words only, hard monthly caps, `src/solddata.ts`). A test fails if any other module makes network calls.

## Threats and answers

| Threat | Answer |
| --- | --- |
| Someone finds the web address | They see a sign-in page. No data without a passkey |
| A manager's phone is stolen | It's locked by its own fingerprint or PIN; K removes that person's passkeys and signs them out everywhere |
| A phishing page copies the sign-in | Passkeys only work on the real site's domain, so they can't be phished |
| An approval link leaks | It also needs the receiving device's session, and it expires after 7 days |
| Someone brute-forces sign-in | There are no passwords to guess, and attempts are rate-limited |
| A cross-site request tries to approve something | Blocked: `SameSite=Strict` cookies plus a required custom header |
| A bug tries an eBay call it shouldn't | The allowlist refuses it; the write gate refuses unapproved changes |
| Claude is tricked by text in a buyer message | Claude can only draft. Its tools can't change eBay, and every draft needs a person's approval |
| The Azure account or a secret is compromised | K revokes the app in eBay's account settings, which cuts access instantly, then rotates secrets |
