# Microsoft Power Platform

K's plan (2026-11-15) adds five Power Platform pieces around EBayManager: a custom connector, a Power BI
report, Power Automate flows, a Power Apps intake app and a Copilot Studio agent. This page is what was built
for it in the app, the rules it keeps, and what is left for K to do in the Microsoft tenant.

**Where it stands (2026-11-19).** The app's side is built and tested on the branch `power-platform`, not
merged, and switched on for Sandbox only (production has no keys). In K's developer environment both connectors are
imported, the Shop Health report runs in Power BI Desktop against Sandbox, and two of the three flows run. Stock Room
and the agent are still recipes in [`powerplatform/`](../powerplatform/README.md); the phase table below says what is proven.

## The rules, and how the code keeps them

| Rule (the plan's ground rules) | How it's kept |
| --- | --- |
| The write gate stays the only way to change eBay. No Power Platform piece holds eBay tokens or calls eBay. | The new code (`src/ro/`, `src/intake.ts`) imports no eBay client, no proposal code and not the write gate. `test/readonly.test.ts` follows every import from those files and fails if one reaches `src/ebay/write.ts`, `src/proposals.ts`, an eBay client or Claude. The existing source scans (`test/safety.test.ts`) are unchanged and pass. |
| Approvals use the existing signed, expiring, POST-only links. No new way to approve. | The read-only API only repeats the links the push notification already carries (`src/links.ts`, the same signature). Opening one shows the change; deciding is still that page's POST. They're given only on the real account, where the page also needs a signed-in device; on Sandbox, where a link alone decides, the API gives only the app's address. Replies and offer answers get no link (they're decided in the app). |
| Read-only access is a separate, scoped key that can never create, approve or reject. | `RO_API_KEY`, sent as `X-Api-Key`. Every route is a GET; the tests run each one against a store whose writes throw. It opens nothing else: not `/api/*`, not `/decide`, not intake. Wrong key: the same blank 404 as the rest of the hidden site, answered without touching the store. 60 requests a minute. There's no lock-out by address: Power Platform calls from addresses many tenants share, so one would let a stranger's wrong guesses shut the flows out, and a 32-byte random key can't be guessed. |
| No buyer personal data leaves. | Orders are stored without buyer fields. A proposal leaves with only allowlisted fields per kind (`PAYLOAD_FIELDS` in `src/ro/tables.ts`); a reply to a buyer leaves with no text and no reason; an offer answer with prices only. eBay's order number is replaced by a hash. K's floor prices and notes are never sent. A test plants a buyer's name, address, phone number and messages and searches every route, tool and export for them. |
| No Excel profit dashboard. | No workbook. The report opens on pricing accuracy, then approvals, health and AI cost; sales come last and there is no profit figure. |
| The PWA stays the family's main tool. | Nothing here decides or edits. Every button opens the app. |

One thing sits outside "read-only", on purpose and with its own key: the Stock Room intake makes **drafts**.
A draft is not a proposal. It can't reach eBay without the wizard and an approved label.

## What was built in the app

### The read-only API (`/api/ro/*`, `src/ro/`)

| Route | Gives |
| --- | --- |
| `GET /status` | environment, live listings, changes waiting, last nightly |
| `GET /listings` | live listings: price, watchers, views, days listed, health flags |
| `GET /sales?days=` | sales: item, price, days to sell |
| `GET /proposals?days=&status=` | suggested changes and what happened to each |
| `GET /proposals/waiting` | what is waiting, who for, hours waited and left, the link to open |
| `GET /pricing`, `GET /pricing/{itemId}` | the engine's latest price and its reasoning |
| `GET /pricing-accuracy?days=` | each sale beside the engine's last price before it sold, and the mean error |
| `GET /health-flags?days=` | nightly health flags, night by night |
| `GET /spend?days=` | Claude spend per day, job and model, with the daily budget |
| `GET /digest?days=` | the week in plain English, as text and as email HTML |
| `GET /export/{name}.csv` | the Power BI files (below) |
| `POST /mcp` | the same reads as nine tools for an agent (MCP over HTTP) |

### The nightly export (`src/ro/export.ts`)

The 02:00 run's new last-but-one step writes eight CSV files to a private `exports` Blob container:
`listings`, `listings_daily`, `sales`, `proposals`, `price_accuracy`, `price_decisions`, `health_flags`,
`claude_spend`. `/api/ro/export/<name>.csv` serves the stored file, or builds it on the spot if there isn't
one (`?live=1` always builds). Power BI reads them through the API with the read-only key, so it never holds a
storage key. CSV rather than Parquet: the files are a few hundred rows, and Power Query reads CSV without a
library in the app. Cells that a spreadsheet would run as a formula are defused.

### Stock Room intake (`POST /api/intake/drafts`, `src/intake.ts`)

Own key (`INTAKE_API_KEY`). Takes an item's name, owner, location, rough condition and one photo, and makes a
new-listing draft. One draft per Stock Room row, 30 a day, 50 open drafts in all. The photo goes through the
same checks as any upload. What the family typed goes in the draft's label only, not into the item's facts.

### Smaller changes

- `src/links.ts`: the link signing, moved out of `src/proposals.ts` unchanged, so read-only code can build the same link without importing anything that writes.
- `src/mcp-core.ts`: the small MCP server, moved out of `src/mcp.ts` so it can serve a read-only tool list too. `/mcp` behaves as before.
- `infra/modules/app.bicep`, `scripts/azure-secrets.mjs`, `scripts/make-keys.mjs`: the two keys and the `exports` container.

## Phase by phase

| Phase | In the app | In K's tenant (not done) |
| --- | --- | --- |
| 0. Read-only API and connector | Built, tested; on for Sandbox | Read-only connector imported in K's developer environment and GetStatus answered `read_only: true` against Sandbox (2026-11-19). Intake connector: import before Phase 3 |
| 1. Power BI "Shop Health" | Export built, tested; model written (Power Query, 38 DAX measures, TMDL); the report written as a Power BI Project (`pbip/`: the model as TMDL files and all five pages), every file checked against Microsoft's schemas | Done against Sandbox (2026-11-19): `ShopHealth.pbip` opened from a copy outside the repository (`scripts/powerbi-open.ps1` sets the key), refreshed, all five pages checked with no visual in error, and saved. Fixes on the way: one-line measures, Anonymous credential, fixed lineage tags (Power BI wouldn't reopen the project without them), taller cards |
| 2. Power Automate | `/proposals/waiting` and `/digest` built, tested | Weekly digest and approval nudges built and run by hand against Sandbox (2026-11-19), sending from Outlook.com: the free Mail connector is blocked for new tenants and the work account has no mailbox. Teams card not built: the work account has no Teams licence (`powerplatform/flows/README.md`) |
| 3. Power Apps "Stock Room" | Intake built, tested | Dataverse tables, canvas app, one flow (`powerplatform/stockroom/README.md`) |
| 4. Copilot Studio "Ask the shop" | Read-only MCP tools built, tested | Create the agent (`powerplatform/copilot/README.md`) |

## For K: what to do, in order

Steps 1 and 2 are done for Sandbox (2026-11-18): it runs this branch with both keys set, and
`check-power-platform.mjs` passes there. The nightly export starts at the next 02:00 run. Commands are for PowerShell, from the repository.

**1. Read the branch and decide whether to merge it.** Branch `power-platform`. With no keys set, it
changes nothing anyone can reach: both APIs answer the blank 404.

**2. Turn it on for Sandbox.**

```powershell
node scripts/make-keys.mjs --power-platform          # adds RO_API_KEY and INTAKE_API_KEY to .dev.vars
node scripts/azure-infra.mjs sandbox                 # adds the two app settings and the exports container
node scripts/azure-secrets.mjs sandbox               # uploads the keys
node scripts/azure-deploy.mjs sandbox                # or: Actions -> deploy -> sandbox, from this branch
```

Check it (reads only, prints no key):

```powershell
node scripts/check-power-platform.mjs                # sandbox; add "production" for the real account
```

Run before step 2 it confirms both APIs are hidden; after, that the key reads and nothing else.

**3. Build the tenant side** against Sandbox, in the plan's order: connector, Power BI, flows, Stock Room,
agent. Each folder's README has the steps and a "check it" list.

**4. Production, when Sandbox is right.** The same four commands with `.prod.vars` and
`$env:EBAY_CONFIRM_PRODUCTION='yes'`, after merging to `main`. Then point the connector's host at production.

To turn either API off again: delete its secret from Key Vault and restart the app. (Removing the line from
the vars file isn't enough: the upload script only adds and replaces.)

## Questions for K

Kept here so nothing waits on an answer; each has what was assumed meanwhile.

1. **Which tenant: personal or KCL?** Personal (K, 2026-11-18). A personal Microsoft account (@outlook.com) can't
   sign in to Power Platform: it answers "Selected user account does not exist in tenant 'Microsoft Services'".
   So K uses a work account made in K's own Microsoft Entra directory (the one behind the Azure subscription),
   with no Azure roles, and signs up for the free Power Apps Developer Plan with it.
2. **Can the family use Stock Room and the agent?** A Developer Plan environment is for one person. Sharing a
   Dataverse app or a Copilot Studio agent with two more people needs licences for them. Assumed: K builds and
   proves it alone first.
3. **Turn the read-only API on for the real account?** Assumed: Sandbox first, production only when K says.
   On production the key can read K's listing titles, prices, sales and the AI's reasons, and nothing about buyers.
4. **Signed approval links in emails and Teams cards.** The plan asks for them; on the real account they are
   given, because the page also needs a signed-in device. On Sandbox they are not, because there a link alone
   decides and the key would then be able to approve. Say if Sandbox should give them too, for testing.
5. **Who gets reminders?** The API names who a change is for (`owner`, or whoever made the draft); each flow
   maps names to email addresses. K fills in that map. No address is stored in the app or sent by it.
6. **The Power BI file holds the read-only key** as a Power Query parameter. Assumed acceptable for a private
   file on K's computer. Publishing to the Power BI service needs Pro, and the key would sit in the service.
7. **The "12.4% backtest" figure** in the plan isn't in the repository. `/pricing-accuracy` measures the live
   number its own way (sold price against the engine's last price before the sale, error as a share of the
   sold price). K should check it means the same thing before quoting either.
8. **Parquet.** The plan allowed CSV or Parquet; CSV was built. Say if Parquet is wanted for the CV wording.
9. **What the family types in Stock Room** (condition, notes) is kept out of the item's facts, so the wizard
   still asks. Say if the condition should pre-fill the wizard's condition step.
10. **Rate limit.** 60 requests a minute, counted per running copy of the app. Enough for the flows (about 120
    calls a day) and a Power BI refresh (8 calls).

## Not built, and why

- **Anything in the tenant.** It needs K's sign-in and licences.
- **A `.pbix` file.** It's a binary made by Power BI Desktop. The model is given as text instead.
- **Flow and solution packages.** An exported flow carries tenant and connection ids; a hand-written one
  wouldn't import. The recipes give every step and expression.
- **Dynamics 365, Power Pages, an Excel workbook, SharePoint lists**: left out by the plan.
