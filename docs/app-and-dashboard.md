# App and dashboard

One web app serves as both the dashboard website and K's Android notification app. It is a Progressive Web App (PWA): K opens it in Chrome and taps **Install app**, after which it has its own icon, runs full screen and receives push notifications with Approve and Reject buttons. It is served by the same Azure Function App as the backend (Cloudflare Worker until 2026-11-05, [azure-migration.md](azure-migration.md)).

Decided 2026-11-02. Web Push is the main notification channel. ntfy stays as an optional fallback.

## Why a PWA

| | PWA + Web Push (chosen) | Website + ntfy | Native Android app |
| --- | --- | --- | --- |
| Apps on the phone | 1 | 2 | 1, plus a separate website |
| Approve from the notification | Yes, via service worker POST | Opens a confirm page | Yes |
| Build and release | Deploy the Worker | Deploy the Worker | APK builds, sideload or Play Store |
| Extra accounts | None | ntfy topic (the topic name is the only secret on ntfy.sh) | Firebase project, Play Console ($25) |
| Delivery | Google's push service (FCM), the same as native apps | ntfy's own connection | FCM |

When PWA pushes can fail on Android:

- K clears Chrome's site data or turns off the site's notification permission.
- Chrome's battery usage is set to **Restricted**, which can delay notifications.
- The push subscription expires. This is rare, and the app re-subscribes each time it opens.

Settings shows **Last push delivered** with a **Send test push** button, so a broken subscription is easy to spot.

## Hosting and cost

| Piece | Where | Cost |
| --- | --- | --- |
| Backend API, timers, background jobs, `/decide` | Azure Functions, Flex Consumption (France Central) | Azure for Students credit; expected under $1 a month |
| Dashboard and PWA files | Served from memory by the same Function App | Free |
| Database | Cosmos DB for NoSQL, free tier (400 RU/s per environment) | Free |
| Photos | Blob Storage (from Phase 10) | Pennies |
| Secrets | Key Vault, read by the app's managed identity | Pennies |
| Login | Email and authenticator-app code for K and up to two managers, set by K with `scripts/people.mjs`; the site is hidden from everyone else | Free |
| Claude | Anthropic API | About $3–6 a month (the only running cost) |

Nothing runs continuously. The app runs only when a request, a push decision, a timer (02:00 nightly, every 15 minutes for messages) or a background job arrives. Running the system on the phone itself would be worse, for no saving: the cron needs a machine that's always on, and eBay's OAuth callback and notifications need a public HTTPS address.

## Stack

- **Frontend:** Vite + Preact + TypeScript in `web/`, built to `web/dist` and bundled into the Function App, which serves it with the SPA fallback and security headers on every response. Tailwind v4 and Framer Motion (through `preact/compat`), mobile first. Look and motion: [design-system.md](design-system.md).
- **Charts:** small hand-rolled SVG components, or uPlot if the time series grow large.
- **API:** JSON routes under `/api/*` in `src/api.ts`, called by the dashboard.
- **Push:** Web Push with one `VAPID_KEY` secret (a P-256 private JWK; the public key is derived from it). Encryption (RFC 8291) and VAPID (RFC 8292) are written on Web Crypto in `src/push.ts`, with no library, and tested by decrypting a message as a browser would. Subscriptions are stored in the data store (`kv` container); gone ones are removed.

## Auth

| Route | Protected by |
| --- | --- |
| `/` and other app paths | Signed-in people only; everyone else gets a blank 404 (a known device is sent to the sign-in page) |
| `/s/<SIGNIN_PATH>` | The hidden sign-in page: email and authenticator code (`src/signin.ts`) |
| `/api/*` | A person's session: a signed `__Host-` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`) set after signing in on the hidden page. State changes also need the `X-EbayManager: 1` header (CSRF). See [security.md](security.md) |
| `/decide/:id` | HMAC-signed link with expiry, POST only (see [approvals.md](approvals.md)) |
| `/mcp` | Bearer `MCP_TOKEN` |
| `/oauth/start` | `MCP_TOKEN` query key, unchanged from Phase 0 |

## Screens

| Screen | Shows | Actions |
| --- | --- | --- |
| **Inbox** (home) | To-dos first (answers, then Claude drafts, then things to do yourself; see [approvals.md](approvals.md#to-dos-2026-11-05-ks-choice)), then pending proposals, newest first. Each label shows old → new values, the reason and guardrail flags | Answer, let Claude draft, done or dismiss; approve, reject, batch approve |
| **Store Pulse** (was Audit, `/pulse`) | A ring of passed checks and a one-line summary of the last first-day audit and how many to-dos and labels it left, with folded sections: listings, sold history, ended listings, settings and what it read (failed parts flagged) | Run again (owner), open the Inbox |
| **Listings** | Every active listing with price, days listed, watchers, floor and pending labels | Review with Claude, price check, K's facts and floor (owner) |
| **Listing detail** | Price, views and watchers over time from snapshots, comps, proposal history, K's floor price and notes | Edit floor and notes (stored in the app only) |
| **Insights** (`/metrics`) | See below, as a bento grid with store health | Run the nightly check now, open Store Pulse |
| **New listing** (`/new`) | A five-step wizard: photos graded in the browser, facts, Claude's description, price, review | Send for approval (a `create_listing` proposal) |
| **Activity** | The audit log: every eBay write, refusal and failure | Filter by outcome |
| **Settings** | Notifications and devices, your account (sign out on all devices), people (the owner sees who can sign in and can sign anyone out), sold data, the reply style guide; **Advanced** holds Pause all writes, Claude spend, connection status, test push and approvals recorded while read-only | Toggle pause, manage devices, edit the style guide (owner) |

A glowing pill is pinned to the top centre of every screen: **Sandbox · test account** (amber), **Live account · read-only** (blue), or none in full production (2026-11-05; it replaced the full-width banner). Push titles carry the same prefix, for example `[SANDBOX] Price: 24.99 → 22.50`.

## Metrics

| Metric | Source |
| --- | --- |
| Active listings, total asking value | `listing_snapshots` |
| Views and watchers per listing over time | Analytics traffic report, `listing_snapshots` |
| Items sold, revenue, fees | Fulfillment `getOrders` (new nightly sync into an `orders` table) |
| Sell-through rate, average days to sell | `orders` joined with `listing_snapshots` |
| Proposals made, approved and rejected; time to decide | `proposals` |
| Promoted Listings ad spend | Marketing API reports |
| Claude spend per day and per job | New `claude_usage` table (tokens and cost per call) |

## PWA details

- `web/manifest.webmanifest`: name, icons, `display: standalone`, theme colour.
- `web/sw.js`:
  - Receives pushes and shows notifications with `approve` and `reject` actions.
  - On an action, POSTs to the signed decide URL carried in the push payload, then shows a "Done" or "Failed" notification.
  - Caches the app shell so the dashboard opens offline. Data is fetched live.
- Subscribing happens in Settings via **Enable notifications on this device**, which calls `POST /api/push/subscribe`.
