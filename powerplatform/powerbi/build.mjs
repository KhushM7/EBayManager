// Writes the Power BI model files from one definition, so they can't drift apart:
//   queries.pq        the Power Query (M) for every table, to read or paste by hand
//   measures.dax      every DAX measure, to read or paste by hand
//   shop-health.tmdl  the whole model as one TMDL script, to paste into Power BI Desktop's TMDL view
//   pbip/             a Power BI Project: the same model as TMDL files and the five report pages (report/report.mjs)
// Run: node powerplatform/powerbi/build.mjs
// test/readonly.test.ts checks every column named here exists in the export of the same name (src/ro/export.ts).
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReport } from "./report/report.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Column types: text, number (decimal), int, date (YYYY-MM-DD), datetime (ISO, UTC), bool.
const M_TYPE = { text: "type text", number: "type number", int: "Int64.Type", date: "type date", datetime: "type datetimezone", bool: "type logical" };
const TMDL_TYPE = { text: "string", number: "double", int: "int64", date: "dateTime", datetime: "dateTime", bool: "boolean" };

/** name: the export file; table: the name in the model; dateFrom: a datetime column to also keep as a plain date. */
const TABLES = [
  { name: "listings", table: "Listings", columns: { item_id: "text", title: "text", price: "number", currency: "text", quantity: "int", watchers: "int", views_7d: "int", impressions_7d: "int", start_date: "datetime", days_listed: "int", health_flags: "text", waiting_changes: "int", snapshot_at: "datetime" } },
  { name: "listings_daily", table: "ListingsDaily", columns: { date: "date", active_listings: "int", asking_total: "number", watchers: "int" }, dateKey: "date" },
  { name: "sales", table: "Sales", columns: { sale_id: "text", sold_at: "datetime", item_id: "text", title: "text", quantity: "int", item_price: "number", line_total: "number", days_to_sell: "number", source: "text" }, dateFrom: ["sold_at", "sold_date"], dateKey: "sold_date" },
  { name: "proposals", table: "Proposals", columns: { id: "text", kind: "text", kind_label: "text", item_id: "text", item_title: "text", status: "text", outcome: "text", applied: "bool", dry_run: "bool", created_at: "datetime", decided_at: "datetime", expires_at: "datetime", hours_to_decide: "number", decided_by: "text", old_price: "number", new_price: "number" }, dateFrom: ["created_at", "created_date"], dateKey: "created_date" },
  { name: "price_accuracy", table: "PriceAccuracy", columns: { sale_id: "text", sold_at: "datetime", item_id: "text", title: "text", group: "text", strategy: "text", predicted_at: "datetime", days_before_sale: "number", predicted_price: "number", market_price: "number", sold_price: "number", error: "number", abs_pct_error: "number" }, dateFrom: ["sold_at", "sold_date"], dateKey: "sold_date" },
  { name: "price_decisions", table: "PriceDecisions", columns: { item_id: "text", decided_at: "datetime", group: "text", strategy: "text", suggested_price: "number", suggested_total_with_postage: "number", market_price: "number", predicted_days: "number" }, dateFrom: ["decided_at", "decided_date"], dateKey: "decided_date" },
  { name: "health_flags", table: "HealthFlags", columns: { date: "date", item_id: "text", title: "text", flag: "text", detail: "text" }, dateKey: "date" },
  { name: "claude_spend", table: "ClaudeSpend", columns: { date: "date", job: "text", model: "text", calls: "int", input_tokens: "int", output_tokens: "int", cost_usd: "number", daily_budget_usd: "number" }, dateKey: "date" },
];

/** table, name, DAX, format, and which report page uses it. */
const MEASURES = [
  // Page 1: pricing accuracy
  ["PriceAccuracy", "Sales Compared", "COUNTROWS ( PriceAccuracy )", "0", "Pricing accuracy"],
  ["PriceAccuracy", "Mean Abs % Error", "AVERAGE ( PriceAccuracy[abs_pct_error] )", "0.0%", "Pricing accuracy"],
  ["PriceAccuracy", "Median Abs % Error", "MEDIAN ( PriceAccuracy[abs_pct_error] )", "0.0%", "Pricing accuracy"],
  ["PriceAccuracy", "Mean Error £", "AVERAGE ( PriceAccuracy[error] )", "£#,0.00;-£#,0.00", "Pricing accuracy"],
  ["PriceAccuracy", "Within 10%", "DIVIDE ( CALCULATE ( COUNTROWS ( PriceAccuracy ), PriceAccuracy[abs_pct_error] <= 0.1 ), [Sales Compared] )", "0%", "Pricing accuracy"],
  ["PriceAccuracy", "Sold Above Prediction", "DIVIDE ( CALCULATE ( COUNTROWS ( PriceAccuracy ), PriceAccuracy[error] > 0 ), [Sales Compared] )", "0%", "Pricing accuracy"],
  ["PriceAccuracy", "Priced Before Sale", "DIVIDE ( [Sales Compared], COUNTROWS ( Sales ) )", "0%", "Pricing accuracy"],
  // Page 2: approval funnel
  ["Proposals", "Suggested", "COUNTROWS ( Proposals )", "0", "Approval funnel"],
  ["Proposals", "Approved", 'CALCULATE ( COUNTROWS ( Proposals ), Proposals[outcome] = "approved" )', "0", "Approval funnel"],
  ["Proposals", "Rejected", 'CALCULATE ( COUNTROWS ( Proposals ), Proposals[outcome] = "rejected" )', "0", "Approval funnel"],
  ["Proposals", "Expired", 'CALCULATE ( COUNTROWS ( Proposals ), Proposals[outcome] = "expired" )', "0", "Approval funnel"],
  ["Proposals", "Waiting", 'CALCULATE ( COUNTROWS ( Proposals ), Proposals[outcome] = "waiting" )', "0", "Approval funnel"],
  ["Proposals", "Applied to eBay", "CALCULATE ( COUNTROWS ( Proposals ), Proposals[applied] = TRUE () )", "0", "Approval funnel"],
  ["Proposals", "Approval Rate", "DIVIDE ( [Approved], [Approved] + [Rejected] )", "0%", "Approval funnel"],
  ["Proposals", "Human Override Rate", "DIVIDE ( [Rejected], [Approved] + [Rejected] )", "0%", "Approval funnel"],
  ["Proposals", "Expiry Rate", "DIVIDE ( [Expired], [Suggested] - [Waiting] )", "0%", "Approval funnel"],
  ["Proposals", "Median Hours to Decide", "MEDIAN ( Proposals[hours_to_decide] )", "0.0", "Approval funnel"],
  // Page 3: listing health
  ["HealthFlags", "Flags", "COUNTROWS ( HealthFlags )", "0", "Listing health"],
  ["HealthFlags", "Flagged Listings", "DISTINCTCOUNT ( HealthFlags[item_id] )", "0", "Listing health"],
  [
    "HealthFlags",
    "Flagged Then Changed",
    `VAR flagged = ADDCOLUMNS ( VALUES ( HealthFlags[item_id] ), "@first", CALCULATE ( MIN ( HealthFlags[date] ) ) )
RETURN
    COUNTROWS (
        FILTER (
            flagged,
            VAR i = HealthFlags[item_id]
            VAR d = [@first]
            RETURN
                NOT ISEMPTY ( FILTER ( ALL ( Proposals ), Proposals[item_id] = i && Proposals[applied] = TRUE () && Proposals[created_date] >= d ) )
        )
    )`,
    "0",
    "Listing health",
  ],
  [
    "HealthFlags",
    "Flagged Then Sold",
    `VAR flagged = ADDCOLUMNS ( VALUES ( HealthFlags[item_id] ), "@first", CALCULATE ( MIN ( HealthFlags[date] ) ) )
RETURN
    COUNTROWS (
        FILTER (
            flagged,
            VAR i = HealthFlags[item_id]
            VAR d = [@first]
            RETURN
                NOT ISEMPTY ( FILTER ( ALL ( Sales ), Sales[item_id] = i && Sales[sold_date] >= d ) )
        )
    )`,
    "0",
    "Listing health",
  ],
  ["HealthFlags", "Flagged Sold Rate", "DIVIDE ( [Flagged Then Sold], [Flagged Listings] )", "0%", "Listing health"],
  // Page 4: AI cost
  ["ClaudeSpend", "Claude Cost $", "SUM ( ClaudeSpend[cost_usd] )", "$#,0.00", "AI cost"],
  ["ClaudeSpend", "Claude Calls", "SUM ( ClaudeSpend[calls] )", "#,0", "AI cost"],
  ["ClaudeSpend", "Daily Budget $", "MAXX ( ALL ( ClaudeSpend ), ClaudeSpend[daily_budget_usd] )", "$#,0.00", "AI cost"],
  // Blank on days with no spend, so a chart by date shows only days Claude was used.
  ["ClaudeSpend", "Budget Line $", "IF ( NOT ISBLANK ( [Claude Cost $] ), [Daily Budget $] )", "$#,0.00", "AI cost"],
  ["ClaudeSpend", "Avg Daily Cost $", "AVERAGEX ( VALUES ( ClaudeSpend[date] ), [Claude Cost $] )", "$#,0.000", "AI cost"],
  ["ClaudeSpend", "Days Over Budget", "COUNTROWS ( FILTER ( VALUES ( ClaudeSpend[date] ), [Claude Cost $] > [Daily Budget $] ) ) + 0", "0", "AI cost"],
  ["ClaudeSpend", "Budget Used", "DIVIDE ( [Avg Daily Cost $], [Daily Budget $] )", "0%", "AI cost"],
  ["ClaudeSpend", "New Listings Submitted", 'CALCULATE ( COUNTROWS ( Proposals ), Proposals[kind] = "create_listing" ) + 0', "0", "AI cost"],
  ["ClaudeSpend", "Cost per New Listing $", 'DIVIDE ( CALCULATE ( [Claude Cost $], ClaudeSpend[job] = "listing" ), [New Listings Submitted] )', "$#,0.000", "AI cost"],
  // Page 5: sales
  ["Sales", "Revenue £", "SUM ( Sales[line_total] )", "£#,0.00", "Sales"],
  ["Sales", "Items Sold", "SUM ( Sales[quantity] )", "0", "Sales"],
  ["Sales", "Avg Sale Price £", "AVERAGE ( Sales[item_price] )", "£#,0.00", "Sales"],
  ["Sales", "Avg Days to Sell", "AVERAGE ( Sales[days_to_sell] )", "0.0", "Sales"],
  ["Listings", "Active Listings", "COUNTROWS ( Listings )", "0", "Sales"],
  ["Listings", "Asking Total £", "SUMX ( Listings, Listings[price] * Listings[quantity] )", "£#,0.00", "Sales"],
  ["Sales", "Sell-through", "DIVIDE ( [Items Sold], [Items Sold] + [Active Listings] )", "0%", "Sales"],
];

const columnsOf = (t) => ({ ...t.columns, ...(t.dateFrom ? { [t.dateFrom[1]]: "date" } : {}) });

const RELATIONSHIPS = TABLES.filter((t) => t.dateKey).map((t) => ({ from: `${t.table}.${t.dateKey}`, to: "Calendar.Date", name: `${t.table}_Calendar` }));

// --- Power Query ---

const FN_EXPORT = `(name as text) as table =>
let
    // The key goes in a header, so the data source's credential in Power BI is "Anonymous". A wrong or empty key
    // gets the app's blank 404, so an empty one is caught here with a clearer message.
    Key = Text.Trim(ApiKey),
    Checked = if Key = "" then error "Set the ApiKey parameter (Transform data > Edit parameters) to the read-only key, RO_API_KEY." else Key,
    Raw = Web.Contents(Text.TrimEnd(Text.Trim(BaseUrl), "/"), [RelativePath = "api/ro/export/" & name & ".csv", Headers = [#"X-Api-Key" = Checked]]),
    Csv = Csv.Document(Raw, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(Csv, [PromoteAllScalars = true])
in
    Promoted`;

const CALENDAR = `let
    Start = #date(2025, 1, 1),
    End = Date.EndOfYear(Date.From(DateTime.LocalNow())),
    Days = List.Dates(Start, Duration.Days(End - Start) + 1, #duration(1, 0, 0, 0)),
    AsTable = Table.FromList(Days, Splitter.SplitByNothing(), {"Date"}),
    Typed = Table.TransformColumnTypes(AsTable, {{"Date", type date}}),
    Year = Table.AddColumn(Typed, "Year", each Date.Year([Date]), Int64.Type),
    Month = Table.AddColumn(Year, "Month", each Date.ToText([Date], "yyyy-MM"), type text),
    Week = Table.AddColumn(Month, "Week Starting", each Date.StartOfWeek([Date], Day.Monday), type date)
in
    Week`;

function query(t) {
  const types = Object.entries(t.columns).map(([c, k]) => `{"${c}", ${M_TYPE[k]}}`);
  const lines = [`    Source = fnExport("${t.name}"),`, `    Typed = Table.TransformColumnTypes(Source, {${types.join(", ")}}, "en-GB")${t.dateFrom ? "," : ""}`];
  if (t.dateFrom) lines.push(`    WithDate = Table.AddColumn(Typed, "${t.dateFrom[1]}", each Date.From(DateTimeZone.ToUtc([${t.dateFrom[0]}])), type date)`);
  return `let\n${lines.join("\n")}\nin\n    ${t.dateFrom ? "WithDate" : "Typed"}`;
}

const pq = [
  "// Power Query (M) for the Shop Health report. Written by build.mjs: change that, not this.",
  "// Each block is one query; its name is the comment above it. BaseUrl and ApiKey are text parameters.",
  "",
  "// BaseUrl (parameter, text): the app's address, with no slash at the end",
  '"https://ebay-autopilot-sandbox-wrpoyt.azurewebsites.net"',
  "",
  "// ApiKey (parameter, text): the read-only key (RO_API_KEY). Never save it in a file you share",
  '""',
  "",
  "// fnExport (function)",
  FN_EXPORT,
  "",
  "// Calendar",
  CALENDAR,
  "",
  ...TABLES.flatMap((t) => [`// ${t.name}`, query(t), ""]),
].join("\n");
writeFileSync(join(here, "queries.pq"), pq);

// --- DAX ---

let dax = "// DAX measures for the Shop Health report. Written by build.mjs: change that, not this.\n// Each is: home table, name, format string, then the expression.\n";
let page = "";
for (const [table, name, expr, format, p] of MEASURES) {
  if (p !== page) dax += `\n// ===== ${(page = p)} =====\n`;
  dax += `\n// ${table} · format ${format}\n${name} =\n${expr.split("\n").map((l) => `    ${l}`).join("\n")}\n`;
}
writeFileSync(join(here, "measures.dax"), dax);

// --- TMDL ---
// Each object is written at depth 0; the one-file script indents it under createOrReplace, and the Power BI Project
// (pbip/) keeps it as a folder of TMDL files. Both come from the same text.

const T = (n) => "\t".repeat(n);
const block = (text, n) => text.split("\n").map((l) => (l ? T(n) + l.replace(/^( {4})+/, (s) => "\t".repeat(s.length / 4)) : "")).join("\n");
const indent = (text, n) => text.split("\n").map((l) => (l ? T(n) + l : l)).join("\n");
// Every object gets a lineageTag made from its name, the same on every build. Without them Power BI Desktop makes new
// random ones each time it opens the project, and its own saved state (.pbi/unappliedChanges.json) then names tags
// that no longer exist: "Lineage tag … was not found" and the project won't open (2026-11-19).
const tag = (path) => {
  const h = createHash("sha1").update(`ShopHealth/${path}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const lt = (path, n) => `${T(n)}lineageTag: ${tag(path)}\n`;
const q = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

const expressionsTmdl = [
  `expression BaseUrl = "https://ebay-autopilot-sandbox-wrpoyt.azurewebsites.net" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]\n${lt("expression/BaseUrl", 1)}`,
  // Always empty in the repository: the key is set in Power BI Desktop, in a copy kept outside it.
  `expression ApiKey = "" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]\n${lt("expression/ApiKey", 1)}`,
  `expression fnExport =\n${block(FN_EXPORT, 2)}\n${lt("expression/fnExport", 1)}`,
].join("\n");

let calendarTmdl = `table Calendar\n${T(1)}dataCategory: Time\n${lt("table/Calendar", 1)}\n`;
for (const [c, type, extra] of [["Date", "dateTime", `${T(2)}isKey\n${T(2)}formatString: dd mmm yyyy\n`], ["Year", "int64", ""], ["Month", "string", ""], ["Week Starting", "dateTime", `${T(2)}formatString: dd mmm yyyy\n`]])
  calendarTmdl += `${T(1)}column ${q(c)}\n${T(2)}dataType: ${type}\n${extra}${lt(`table/Calendar/column/${c}`, 2)}${T(2)}summarizeBy: none\n${T(2)}sourceColumn: ${c}\n\n`;
calendarTmdl += `${T(1)}partition Calendar = m\n${T(2)}mode: import\n${T(2)}source =\n${block(CALENDAR, 4)}\n`;

function tableTmdl(t) {
  let out = `table ${t.table}\n${lt(`table/${t.table}`, 1)}\n`;
  for (const [, name, expr, format] of MEASURES.filter((m) => m[0] === t.table)) {
    // Always on one line: Power BI Desktop's TMDL view refused a multi-line measure followed by its formatString
    // ("Unexpected expression formatString", 2026-11-19). measures.dax keeps the readable layout.
    out += `${T(1)}measure ${q(name)} = ${expr.replace(/\s*\n\s*/g, " ")}\n`;
    out += `${T(2)}formatString: ${format}\n${lt(`table/${t.table}/measure/${name}`, 2)}\n`;
  }
  for (const [c, k] of Object.entries(columnsOf(t))) {
    const fmt = k === "date" ? "dd mmm yyyy" : k === "datetime" ? "General Date" : c === "abs_pct_error" ? "0.0%" : "";
    // Ids and day counts are never summed by default; money and counts are.
    const sum = ["number", "int"].includes(k) && !/(_id|days_listed|daily_budget_usd|abs_pct_error|price|days_to_sell|days_before_sale|predicted_days|hours_to_decide|rate)$/.test(c) ? "sum" : "none";
    out += `${T(1)}column ${q(c)}\n${T(2)}dataType: ${TMDL_TYPE[k]}\n${fmt ? `${T(2)}formatString: ${fmt}\n` : ""}${lt(`table/${t.table}/column/${c}`, 2)}${T(2)}summarizeBy: ${sum}\n${T(2)}sourceColumn: ${c}\n\n`;
  }
  return `${out}${T(1)}partition ${t.table} = m\n${T(2)}mode: import\n${T(2)}source =\n${block(query(t), 4)}\n`;
}

const relationshipsTmdl = RELATIONSHIPS.map((r) => `relationship ${r.name}\n${T(1)}fromColumn: ${r.from}\n${T(1)}toColumn: ${r.to}\n`).join("\n");
const tableTexts = [["Calendar", calendarTmdl], ...TABLES.map((t) => [t.table, tableTmdl(t)])];

const tmdl = `createOrReplace\n\n${[expressionsTmdl, ...tableTexts.map(([, x]) => x), relationshipsTmdl].map((x) => indent(x, 1)).join("\n")}`;
writeFileSync(join(here, "shop-health.tmdl"), tmdl);

// --- Power BI Project (pbip/) ---

const model = {
  tables: Object.fromEntries([["Calendar", { columns: ["Date", "Year", "Month", "Week Starting"], measures: [] }], ...TABLES.map((t) => [t.table, { columns: Object.keys(columnsOf(t)), measures: MEASURES.filter((m) => m[0] === t.table).map((m) => m[1]) }])]),
};
const files = writeReport({ model });
const modelDir = "ShopHealth.SemanticModel/definition";
files[`${modelDir}/database.tmdl`] = "database\n\tcompatibilityLevel: 1567\n";
files[`${modelDir}/model.tmdl`] = [
  "model Model",
  "\tculture: en-GB",
  "\tdefaultPowerBIDataSourceVersion: powerBI_V3",
  "\tsourceQueryCulture: en-GB",
  "\tdataAccessOptions",
  "\t\tlegacyRedirects",
  "\t\treturnErrorValuesAsNull",
  // No hidden date tables for every date column: Calendar is the date table.
  "\tannotation __PBI_TimeIntelligenceEnabled = 0",
  "",
  ...tableTexts.map(([n]) => `ref table ${q(n)}`),
  "",
].join("\n");
files[`${modelDir}/expressions.tmdl`] = expressionsTmdl;
files[`${modelDir}/relationships.tmdl`] = relationshipsTmdl;
for (const [n, x] of tableTexts) files[`${modelDir}/tables/${n}.tmdl`] = x;
files["ShopHealth.SemanticModel/definition.pbism"] = JSON.stringify({ $schema: "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json", version: "4.0", settings: {} }, null, 2) + "\n";
files["ShopHealth.SemanticModel/.platform"] = platform("SemanticModel", "ShopHealth", "5f0c9a3e-2b7d-4c61-9e84-6a1d3f0b7c25");
files["ShopHealth.Report/.platform"] = platform("Report", "ShopHealth", "8e2d4b17-93a6-4f0e-b5c8-1d7a6e3f9024");
files["ShopHealth.pbip"] = JSON.stringify({ $schema: "https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json", version: "1.0", artifacts: [{ report: { path: "ShopHealth.Report" } }], settings: { enableAutoRecovery: true } }, null, 2) + "\n";

function platform(type, displayName, logicalId) {
  return JSON.stringify({ $schema: "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json", metadata: { type, displayName }, config: { version: "2.0", logicalId } }, null, 2) + "\n";
}

const pbip = join(here, "pbip");
rmSync(join(pbip, "ShopHealth.Report", "definition"), { recursive: true, force: true });
rmSync(join(pbip, "ShopHealth.SemanticModel", "definition"), { recursive: true, force: true });
for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(pbip, path)), { recursive: true });
  writeFileSync(join(pbip, path), text);
}
// Power BI's own base theme, unchanged (MIT, from github.com/microsoft/fabric-cicd, sample/workspace).
const themeDir = join(pbip, "ShopHealth.Report/StaticResources/SharedResources/BaseThemes");
mkdirSync(themeDir, { recursive: true });
copyFileSync(join(here, "report", "CY24SU10.json"), join(themeDir, "CY24SU10.json"));

console.log(`Wrote queries.pq, measures.dax, shop-health.tmdl and pbip/ (${TABLES.length} tables, ${MEASURES.length} measures, ${RELATIONSHIPS.length} relationships)`);
