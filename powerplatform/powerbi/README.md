# Shop Health: the Power BI report

A Power BI Desktop report over EBayManager's own data. It leads with pricing accuracy, human approvals and AI
cost: it is a view of how well the app's decisions hold up, not a profit dashboard.

The data comes from the nightly export: at 02:00 the app writes eight CSV files with no buyer details to its
private `exports` Blob container, and serves them at `/api/ro/export/<name>.csv` to the read-only key. Power
Query loads those; DAX does the sums.

| File here | What it is |
| --- | --- |
| `shop-health.tmdl` | The whole model as one TMDL script: 2 parameters, the loader function, 9 tables, 37 measures, 7 relationships |
| `queries.pq` | The same Power Query, one block per query, to paste by hand |
| `measures.dax` | The same measures, to paste by hand |
| `build.mjs` | Writes the three files above from one definition (`node powerplatform/powerbi/build.mjs`) |

None of this has been opened in Power BI Desktop yet. The columns are checked against the export
(`test/readonly.test.ts`); the DAX and TMDL are unproven until K loads them.

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

**If the refresh says "The 'X-Api-Key' header is only supported when connecting anonymously"**, Power BI saved
another kind of sign-in for the address. File → Options and settings → **Data source settings** → pick the
app's address → **Clear Permissions** → Close. Refresh again and, when asked, choose **Anonymous**, with the
level set to the address's root (`https://ebay-autopilot-…azurewebsites.net/`), so it covers every file.

### 2. The pages

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
