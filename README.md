# EBayManager (ebay-autopilot)

K's eBay selling assistant. An Azure Function App that holds the eBay connection and the rules, asks Claude for
judgement, and serves the app (an installable phone and desktop app). It improves existing listings, re-evaluates
unsold ones, builds new listings from photos and drafts buyer replies. **Nothing changes on eBay until a person
approves it**, from a notification or the Inbox.

- Decisions and current state: [CLAUDE.md](CLAUDE.md). Plan: https://claude.ai/artifact/JowUE86DsPhFBsswMms8jf
- Design docs: [security](docs/security.md) · [approvals](docs/approvals.md) · [pricing engine](docs/pricing-engine.md) ·
  [listing assistant](docs/listing-assistant.md) · [add listing](docs/add-listing.md) · [app and dashboard](docs/app-and-dashboard.md) ·
  [safety and environments](docs/safety-and-environments.md) · [go-live tests](docs/go-live-tests.md) · [roadmap](docs/roadmap.md)

## Where it runs

| | Sandbox (testing) | Production (your real eBay account) |
| --- | --- | --- |
| Address | https://ebay-autopilot-sandbox-wrpoyt.azurewebsites.net | https://ebay-autopilot-production-wrpoyt.azurewebsites.net |
| eBay | eBay's Sandbox, test users only | Your real account, **approval mode**: every change needs a person's Approve |
| Secrets file (gitignored) | `.dev.vars` | `.prod.vars` |
| Who runs commands | You or Claude | **You only**: every production script needs `$env:EBAY_CONFIRM_PRODUCTION='yes'` |

The site is **hidden**: anyone not signed in sees a blank page everywhere. You sign in at a secret address
(`/s/<SIGNIN_PATH>`) with your email and the 6-digit code from Google or Microsoft Authenticator.

**It runs 24/7 without your computer.** Azure starts the app when someone opens it or a timer is due, and lets it
sleep in between: the nightly review at 02:00 UTC, the buyer-message and offer poll every 15 minutes, and
background jobs. After a quiet spell the first page load can take a few seconds. Two things eventually need you:
- **The eBay connection lasts about 18 months.** When it ends, Settings shows "Connect your eBay account" again; sign in to eBay there.
- **Your session lasts 30 days on a device where you ticked "Stay signed in".** Then sign in again with your code.

## Everyday commands (PowerShell, from this folder)

Production commands need `$env:EBAY_CONFIRM_PRODUCTION='yes'` (set once per PowerShell window).

```powershell
npm install                                               # once, and after pulling new code
az login                                                  # your Azure sign-in, when it asks

# Check everything is healthy (read-only; safe any time)
node scripts/check-production.mjs                         # production
node scripts/check-production.mjs sandbox                 # sandbox

# Deploy new code (typecheck, tests, build, upload)
node scripts/azure-deploy.mjs sandbox                     # Claude may run this one
$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-deploy.mjs production

# Change infrastructure (only when the Bicep in infra/ changes)
$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-infra.mjs production

# Upload changed secrets from .prod.vars to Key Vault, then make every copy of the app use them
$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-secrets.mjs production
$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/people.mjs production refresh
```

## People: you and up to two managers

People are set **only** from your computer with `scripts/people.mjs`. The app itself has no way to add, change or
remove anyone. Each command saves the list in `.prod.vars` (gitignored), uploads it to Key Vault, restarts the
app and checks the sign-in page loads every time. Never paste the QR code, the setup key or `.prod.vars` anywhere.

| You want to | Run (production) |
| --- | --- |
| See who's set up | `node scripts/people.mjs production list` |
| Show the hidden sign-in address | `node scripts/people.mjs production link` |
| Add a manager | `node scripts/people.mjs production add --email them@example.com --name Sam --role manager` |
| Give someone a new phone or authenticator | `node scripts/people.mjs production new-code --email them@example.com` |
| Fix a mistyped email (same authenticator) | `node scripts/people.mjs production change-email --email old@example.co --to new@example.com` |
| Remove a manager (ends their sessions) | `node scripts/people.mjs production remove --email them@example.com` |
| A fresh sign-in address (if the old one was shared) | `node scripts/people.mjs production new-link` |
| The sign-in page only loads some of the time | `node scripts/people.mjs production refresh` |

Put `$env:EBAY_CONFIRM_PRODUCTION='yes';` in front of each, or set it once in the window. For Sandbox, use
`sandbox` instead of `production` (Sandbox has its own people, codes and sign-in address).

### Adding a manager, step by step

Do this with the manager next to you, or on a video call, so the QR code is only ever on your screen.

1. On your computer:
   ```powershell
   $env:EBAY_CONFIRM_PRODUCTION='yes'
   node scripts/people.mjs production add --email sam@example.com --name Sam --role manager
   ```
2. A QR code image opens. The manager scans it in **Google Authenticator** or **Microsoft Authenticator** (Add, then
   Scan a QR code). If scanning fails: Enter a setup key, type **Time based**, and the key exactly as printed. Then
   press Enter in your terminal: the image is deleted.
3. The script uploads, restarts the app and prints the **sign-in address**. Send it to the manager privately (a
   direct message, not a group).
4. The manager, on their phone:
   - opens the address in Chrome, signs in with their email and the current code, keeping **Stay signed in for 30 days** ticked;
   - Chrome menu (⋮) → **Install app**, then opens the app from the home screen;
   - **Settings → This device → Turn on** for notifications, then **Settings → Advanced → Send test push**.
5. On a laptop: open the same address, bookmark it, and sign in (untick "Stay signed in" on a shared computer).
6. You check **Settings → People** shows them, and run go-live tests B11 and B12 ([go-live-tests.md](docs/go-live-tests.md)).

**What a manager can do:** see everything, approve or reject changes, edit reply drafts, make new listings and
pause all changes. **Owner only:** resume changes, the auto-apply switches, connecting eBay, answering the Inbox's
questions about your items, setting prices directly, and signing other people out.

**If a manager loses their phone:** sign them out from Settings → People → Sign out everywhere, then
`people.mjs production new-code --email ...` when they have a new one. To end their access: `remove`.

## Finishing touches (one time)

- [ ] Merge the latest work branch into `main` with a pull request (now `photo-tools-and-live-fixes`), so GitHub's main matches what's live.
- [ ] Turn on your authenticator app's cloud backup (Google Authenticator: sign in with your Google account;
      Microsoft Authenticator: Settings → Cloud backup), so a lost phone doesn't lock you out.
- [ ] Remove the app from your phone's home screen and install it again, so the new logo shows (Chrome menu ⋮ → Install app).
- [ ] For the first few weeks, read each label before approving, and tell Claude anything that reads wrongly.
      Set floors under Listings → Facts and floor.
- [ ] When managers join: the steps above, then go-live tests B11, B12 and H1 on their phones.

## Costs

Measured from the app's own logs (2026-11-03 to 2026-11-07) and Azure's published prices.

| | What it is | Expect |
| --- | --- | --- |
| **Claude (Anthropic API)** | Haiku for nightly checks and reply drafts; Sonnet for photo checks, specs (with web search) and listing text | **About $2 to $8 a month.** Day to day the nightly checks cost cents; each new listing about $0.30 to $0.80. Hard cap: $1 a day (`CLAUDE_DAILY_BUDGET_USD`); Settings → Advanced shows the spend |
| **Azure Functions (Flex Consumption)** | Runs only when used, 512 MB, sleeps when idle | **£0 to £1**, inside the monthly free allowance at this use |
| **Cosmos DB** | Free tier: one account, both databases | **£0** |
| **Blob Storage, queue, Key Vault, logs** | Photos (deleted 30 days after listing), jobs, secrets, logs capped at 0.15 GB a day | **Pennies, under £1** |
| **Sold-price data** | Trawl and CompsAPI, hard monthly caps (250 and 100 look-ups) | Their plans' prices; capped |
| **Photo AI (Container Apps)** | Background removal, spot removal and upscale in K's own container, scaled to zero ([docs/imageai.md](docs/imageai.md)) | **£0 when not used.** Billed only while an edit runs (plus 2 minutes before it scales back to zero), inside Azure's monthly free grant at this use |
| **Azure in total** | | **About £0 to £3 a month.** A budget alert emails you at 50% and 100% of $5 |

So far: production Claude $1.39 in 5 days (mostly the one-off first-day audit and spec look-ups), Sandbox $1.12.

## Develop

```sh
npm run typecheck && npm test   # tsc + vitest
MOCK=1 npm run dev:web          # the app on sample data, no account needed (MOCK=signedout: the signed-out screen)
npm run test:cosmos             # the store's tests against the Cosmos DB emulator, if installed
node scripts/make-icons.mjs     # redraw the app icons from the logo (web/src/logo.tsx)
```

| Path | Does |
| --- | --- |
| `src/ebay/write.ts` | The write gate: the only code that sends eBay writes, with the kill switch and audit log |
| `src/ebay/allowlist.ts` | Every eBay call the app may make; anything else is refused |
| `src/proposals.ts` | Every eBay change is a proposal; signed, expiring approval links |
| `src/auth/`, `src/signin.ts`, `scripts/people.mjs` | Sign-in: the people list, authenticator codes, sessions, the hidden sign-in page |
| `src/pricing/` | The pricing engine |
| `src/drafts.ts`, `src/newlisting.ts`, `web/src/wizard.tsx`, `web/src/listing/` | New listing: photos (Adjust, Arrange, Tidy), facts, text, price, postage |
| `src/platform/azure/`, `infra/` | The Azure Functions adapter and the Bicep templates |
| `web/` | The app (Preact, Tailwind, Framer Motion) |

There is deliberately no tool that changes eBay directly. Changes are proposals; only an approved proposal reaches
the write gate, and the safety tests fail if any other code tries.
