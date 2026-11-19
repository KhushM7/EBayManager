# Shop Health: the Power BI report

A Power BI Desktop report over EBayManager's own data. It leads with pricing accuracy, human approvals and AI
cost: it is a view of how well the app's decisions hold up, not a profit dashboard.

The data comes from the nightly export: at 02:00 the app writes eight CSV files with no buyer details to its
private `exports` Blob container, and serves them at `/api/ro/export/<name>.csv` to the read-only key. Power
Query loads those; DAX does the sums.

| File here | What it is |
| --- | --- |
| `shop-health.tmdl` | The whole model as one TMDL script: 2 parameters, the loader function, 9 tables, 38 measures, 7 relationships |
| `queries.pq` | The same Power Query, one block per query, to paste by hand |
| `measures.dax` | The same measures, to paste by hand |
| `pbip/` | The finished report as a Power BI Project: `ShopHealth.pbip`, the model as TMDL files and the five pages (PBIR) |
| `report/report.mjs` | The five pages' layout, written into `pbip/` |
| `build.mjs` | Writes all of the above from one definition (`node powerplatform/powerbi/build.mjs`) |
| `validate.py` | Checks every JSON file in `pbip/` against Microsoft's schemas (how to run it is at its top) |

The finished project in `pbip/` was opened in Power BI Desktop, refreshed against Sandbox and saved (2026-11-19): all
five pages load with no visual in error (most are empty, as Sandbox has little data). The columns are checked against
the export (`test/readonly.test.ts`), and every JSON file passes Microsoft's schemas.

## Open the finished report (quickest)

The project has the model and all five pages already in place. Open a **copy** outside the repository: Power BI
writes the key into the copy's files when you save, and it caches downloaded rows in `.pbi/` folders.

1. From the repository, run `powershell -ExecutionPolicy Bypass -File scripts\powerbi-open.ps1`. It copies the
   project to `..\EbayManagerPowerPlatform\ShopHealth`, fills in `ApiKey` from `.dev.vars` (never shown) and opens
   it. Run it again after any change to the project; it replaces the copy's pages and model but keeps Power BI's cache.
2. If Power BI Desktop won't open it, turn on File → Options and settings → Options → Preview features → **Power BI
   Project (.pbip) save option** and **Store reports using enhanced metadata format (PBIR)**, restart, and run the
   script again.
3. Refresh. The Anonymous sign-in you saved for the address is reused.
   If every table says "Set the ApiKey parameter…" (and the rest "0x80040E4E", a load cancelled by that one), the copy
   was opened without the key: set it under Transform data → Edit parameters, or run the script again.
   If it says "Unable to open document: Lineage tag … was not found", Power BI's saved edits from an older copy are in
   the way: run the script again (it deletes `.pbi/unappliedChanges.json`). Every object in the model has a fixed
   `lineageTag` made by `build.mjs` from its name, so this shouldn't come back.
4. Go through the five pages. On Sandbox most visuals are empty; what matters is that none shows an error.
   Save (Ctrl+S) keeps the copy as a project. The old `dashboard.pbix` can then be deleted.

Built a little differently from the recipe below: the funnel is a bar per stage (Suggested, Approved, Applied to
eBay), since the funnel visual can't show three separate measures; the scatter's line is Power BI's ratio line
(the average sold-to-predicted ratio, which sits on y = x when the engine is right on average); and the AI cost
chart's budget line is `Budget Line $`, which is blank on days with no spend so the chart shows only days Claude
ran. To change a page, change `report/report.mjs`, run `build.mjs`, then `validate.py`, and copy the project again.

## Build it

### 1. The model

**Quick way (try first).** Power BI Desktop → new report → **TMDL view** (left rail) → paste all of
`shop-health.tmdl` → **Apply**. Then **Transform data** → **Edit parameters**: set `BaseUrl` (no slash at the
end) and `ApiKey` (the read-only key). **Refresh**. When asked how to sign in to the address, choose
**Anonymous** (the key travels in a header) and privacy level **Organizational**.

**By hand (if Apply refuses the script).** Transform data → **Manage parameters** → make `BaseUrl` and `ApiKey`
(text). For each block in `queries.pq`: **New source → Blank query → Advanced editor**, paste the block, and
name the query as the comment says (`fnExport`, `Calendar`, then the eight tables: name them `Listings`,
`ListingsDaily`, `Sales`, `Proposals`, `PriceAccuracy`, `PriceDecisions`, `HealthFlags`, `ClaudeSpend`). Close
and apply. In Model view, drag each table's date column onto `Calendar[Date]` (many to one): `Sales[sold_date]`,
`Proposals[created_date]`, `PriceAccuracy[sold_date]`, `PriceDecisions[decided_date]`, `HealthFlags[date]`,
`ClaudeSpend[date]`, `ListingsDaily[date]`. Mark `Calendar` as the date table. Then add each measure from
`measures.dax` to the table its comment names, with its format.

**If every table says "(404): Not Found"**, the key didn't match: the app answers a wrong or empty key with a
blank 404. Set `ApiKey` again (Transform data → Edit parameters), copied fresh from `.dev.vars`. Pasting the
TMDL script again resets both parameters to the values in the file, so set them after every paste.

**If the refresh says "The 'X-Api-Key' header is only supported when connecting anonymously"**, Power BI saved
another kind of sign-in for the address. File → Options and settings → **Data source settings** → pick the
app's address → **Clear Permissions** → Close. Refresh again and, when asked, choose **Anonymous**, with the
level set to the address's root (`https://ebay-autopilot-…azurewebsites.net/`), so it covers every file.

### 2. The pages

Already built in `pbip/` (above). By hand, in a report loaded from the TMDL script:


Put a `Calendar[Date]` slicer (Between) on every page, synced.

**Page 1. Pricing accuracy** (the page the report opens on)
- Cards: `Mean Abs % Error`, `Median Abs % Error`, `Within 10%`, `Mean Error £`, `Sales Compared`, `Priced Before Sale`.
- Scatter: X `PriceAccuracy[predicted_price]`, Y `PriceAccuracy[sold_price]`, details `title`, tooltip `strategy`. Add a y = x line (Analytics → Ratio line, or a constant-slope line): dots above sold for more than predicted.
- Line: `Calendar[Month]` by `Mean Abs % Error`, with `Sales Compared` as columns on a second axis so a month with two sales reads as two sales.
- Bar: `PriceAccuracy[group]` by `Mean Abs % Error`. Second bar: `PriceAccuracy[strategy]` by `Mean Error £` (which strategies run high or low).
- Table: title, sold_at, predicted_price, sold_price, error, abs_pct_error, days_before_sale.
- Note on the page: "Each sale against the engine's last price before it sold. `Priced Before Sale` is the share of sales the engine had priced at all."

**Page 2. Approval funnel**
- Funnel: `Suggested` → `Approved` → `Applied to eBay`. Cards: `Approval Rate`, `Human Override Rate`, `Expiry Rate`, `Median Hours to Decide`, `Waiting`.
- Stacked bar: `Proposals[kind_label]` by count, legend `Proposals[outcome]` (which kinds people reject most).
- Bar: `Proposals[decided_by]` by `Approved` and `Rejected`.
- Line: `Calendar[Week Starting]` by `Human Override Rate`.
- Slicer: `Proposals[dry_run]` (False for real changes only).
- Note: "Every change to eBay needs a person. `Human Override Rate` is how often a person said no to the AI."

**Page 3. Listing health**
- Cards: `Flagged Listings`, `Flagged Then Changed`, `Flagged Then Sold`, `Flagged Sold Rate`.
- Stacked column: `Calendar[Week Starting]` by `Flags`, legend `HealthFlags[flag]`.
- Table: `HealthFlags[title]`, flag, first `date`, last `date`, `Flags`.
- Table of live listings: `Listings[title]`, price, days_listed, watchers, views_7d, health_flags, waiting_changes.

**Page 4. AI cost**
- Cards: `Claude Cost $`, `Avg Daily Cost $`, `Budget Used`, `Days Over Budget`, `Cost per New Listing $`.
- Column: `Calendar[Date]` by `Claude Cost $`, with `Daily Budget $` as a constant line.
- Bar: `ClaudeSpend[job]` by `Claude Cost $`. Bar: `ClaudeSpend[model]` by `Claude Cost $`.

**Page 5. Sales**
- Cards: `Revenue £`, `Items Sold`, `Avg Sale Price £`, `Avg Days to Sell`, `Sell-through`, `Active Listings`.
- Column: `Calendar[Month]` by `Revenue £`, line `Items Sold`.
- Line: `ListingsDaily[date]` by `active_listings` and `asking_total`.
- Table: `Sales[title]`, sold_at, item_price, quantity, days_to_sell, source.
- `Sell-through` is items sold in the period over items sold plus what is live now: a rough figure, and the page should say so.

### 3. Things to know

- **The key sits in the file.** A Power Query parameter is stored in the `.pbix` as plain text. Keep the file private, never commit it, and never publish it to a shared workspace with the key inside. If it leaks, change `RO_API_KEY` (it can only read, and holds no buyer details).
- **Refresh.** Desktop refresh is free. A scheduled refresh in the Power BI service needs the report published (a Pro licence to share it) and the same Anonymous credential there.
- **Freshness.** The files are last night's. Add `?live=1` (in `fnExport`, after `.csv`) only to check something today: it reads the whole store each time.
- **Small numbers.** With a few dozen sales, one odd sale moves `Mean Abs % Error` a lot. Show `Sales Compared` beside it, always.
