// The Shop Health report's five pages as a Power BI Project report (PBIR), written by build.mjs into pbip/.
// The layout follows README.md, "2. The pages". Every field is checked against the model here, so a renamed
// column or measure fails the build rather than showing a broken visual in Power BI Desktop.
// Schemas (github.com/microsoft/json-schemas, fabric/item/report/definition): report 3.0.0, page 2.0.0,
// visualContainer 2.4.0, pagesMetadata 1.0.0, versionMetadata 1.0.0. validate.py checks every file against them.
import { createHash } from "node:crypto";

const SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/item/report/definition";
const W = 1280;
const H = 720;
const AGG = { sum: 0, avg: 1, min: 3, max: 4 };

const id = (...parts) => createHash("sha1").update(parts.join("/")).digest("hex").slice(0, 20);
const json = (o) => JSON.stringify(o, null, 2) + "\n";
const lit = (v) => ({ expr: { Literal: { Value: v } } });
const str = (s) => lit(`'${s.replace(/'/g, "''")}'`);

/** "Table.field" a column, "Table.[Measure]" a measure, "min:Table.field" an aggregated column. */
function field(ref, model) {
  const [agg, rest] = ref.includes(":") ? ref.split(":") : [null, ref];
  const dot = rest.indexOf(".");
  const table = rest.slice(0, dot);
  let name = rest.slice(dot + 1);
  const isMeasure = name.startsWith("[");
  if (isMeasure) name = name.slice(1, -1);
  const t = model.tables[table];
  if (!t || !(isMeasure ? t.measures : t.columns).includes(name)) throw new Error(`report.mjs: ${ref} is not in the model`);
  const src = { Expression: { SourceRef: { Entity: table } }, Property: name };
  if (isMeasure) return { field: { Measure: src }, queryRef: `${table}.${name}`, nativeQueryRef: name };
  if (!agg) return { field: { Column: src }, queryRef: `${table}.${name}`, nativeQueryRef: name };
  const label = { sum: "Sum", avg: "Average", min: "Min", max: "Max" }[agg];
  return {
    field: { Aggregation: { Expression: { Column: src }, Function: AGG[agg] } },
    queryRef: `${label}(${table}.${name})`,
    nativeQueryRef: `${label} of ${name}`,
  };
}

const title = (text) => ({ title: [{ properties: { show: lit("true"), text: str(text) } }] });

/** One page: its visuals as [type, position, roles, options]. */
function page(name, displayName, visuals, model) {
  const files = {};
  const pid = id("page", name);
  files[`pages/${pid}/page.json`] = json({ $schema: `${SCHEMA}/page/2.0.0/schema.json`, name: pid, displayName, displayOption: "FitToPage", height: H, width: W });
  visuals.forEach(([visualType, [x, y, w, h], roles = {}, opts = {}], i) => {
    const vid = id("visual", name, String(i));
    if (x + w > W || y + h > H) throw new Error(`report.mjs: visual ${i} on ${displayName} is off the page`);
    const visual = { visualType, drillFilterOtherVisuals: true };
    if (Object.keys(roles).length)
      visual.query = { queryState: Object.fromEntries(Object.entries(roles).map(([role, refs]) => [role, { projections: refs.map((r) => field(r, model)) }])) };
    if (opts.sort) visual.query.sortDefinition = { sort: [{ field: field(opts.sort, model).field, direction: "Ascending" }], isDefaultSort: true };
    if (opts.objects) visual.objects = opts.objects;
    if (opts.title) visual.visualContainerObjects = title(opts.title);
    if (opts.syncGroup) visual.syncGroup = opts.syncGroup;
    files[`pages/${pid}/visuals/${vid}/visual.json`] = json({
      $schema: `${SCHEMA}/visualContainer/2.4.0/schema.json`,
      name: vid,
      position: { x, y, z: i * 1000, width: w, height: h, tabOrder: i * 1000 },
      visual,
    });
  });
  return { pid, files };
}

// Shared pieces of every page: the heading, the synced date slicer and the note at the foot.
const heading = (text) => ["textbox", [16, 12, 820, 48], {}, { objects: { general: [{ properties: { paragraphs: [{ textRuns: [{ value: text, textStyle: { fontSize: "20pt", fontWeight: "bold" } }] }] } }] } }];
const note = (text) => ["textbox", [16, 672, 1248, 40], {}, { objects: { general: [{ properties: { paragraphs: [{ textRuns: [{ value: text, textStyle: { fontSize: "10pt" } }] }] } }] } }];
const dates = ["slicer", [960, 8, 304, 64], { Values: ["Calendar.Date"] }, {
  objects: { data: [{ properties: { mode: str("Between") } }] },
  syncGroup: { groupName: "Dates", fieldChanges: true, filterChanges: true },
}];
/** A row of cards across the page at y 76. */
const cards = (measures, x0 = 16, width = 1248) => {
  const w = Math.floor((width - 8 * (measures.length - 1)) / measures.length);
  return measures.map((m, i) => ["card", [x0 + i * (w + 8), 76, w, 96], { Values: [m] }]);
};

const PAGES = [
  ["pricing", "Pricing accuracy", [
    heading("Pricing accuracy"), dates,
    ...cards(["PriceAccuracy.[Mean Abs % Error]", "PriceAccuracy.[Median Abs % Error]", "PriceAccuracy.[Within 10%]", "PriceAccuracy.[Mean Error £]", "PriceAccuracy.[Sales Compared]", "PriceAccuracy.[Priced Before Sale]"]),
    // The ratio line is the average sold/predicted ratio: on it, the engine was right on average.
    ["scatterChart", [16, 180, 408, 240], { Category: ["PriceAccuracy.title"], X: ["avg:PriceAccuracy.predicted_price"], Y: ["avg:PriceAccuracy.sold_price"], Tooltips: ["min:PriceAccuracy.strategy"] },
      { title: "Predicted against sold (above the line: sold for more)", objects: { ratioLine: [{ properties: { show: lit("true") } }] } }],
    ["lineClusteredColumnComboChart", [432, 180, 408, 240], { Category: ["Calendar.Month"], Y: ["PriceAccuracy.[Sales Compared]"], Y2: ["PriceAccuracy.[Mean Abs % Error]"] },
      { title: "Error by month (columns: sales compared)", sort: "Calendar.Month" }],
    ["clusteredBarChart", [848, 180, 416, 116], { Category: ["PriceAccuracy.group"], Y: ["PriceAccuracy.[Mean Abs % Error]"] }, { title: "Error by group" }],
    ["clusteredBarChart", [848, 304, 416, 116], { Category: ["PriceAccuracy.strategy"], Y: ["PriceAccuracy.[Mean Error £]"] }, { title: "Mean error £ by strategy (high or low)" }],
    ["tableEx", [16, 428, 1248, 236], { Values: ["PriceAccuracy.title", "PriceAccuracy.sold_at", "PriceAccuracy.predicted_price", "PriceAccuracy.sold_price", "PriceAccuracy.error", "PriceAccuracy.abs_pct_error", "PriceAccuracy.days_before_sale"] }, { title: "Each sale against the last price" }],
    note("Each sale against the engine's last price before it sold. Priced Before Sale is the share of sales the engine had priced at all. With few sales, one odd sale moves the error a lot: read it beside Sales Compared."),
  ]],
  ["approvals", "Approval funnel", [
    heading("Approval funnel"), dates,
    ...cards(["Proposals.[Approval Rate]", "Proposals.[Human Override Rate]", "Proposals.[Expiry Rate]", "Proposals.[Median Hours to Decide]", "Proposals.[Waiting]"], 16, 1040),
    ["slicer", [1064, 76, 200, 96], { Values: ["Proposals.dry_run"] }, { title: "Dry run (False: real changes)" }],
    // A bar per stage reads as a funnel and draws even with no data, which the funnel visual does not.
    ["clusteredBarChart", [16, 180, 408, 240], { Y: ["Proposals.[Suggested]", "Proposals.[Approved]", "Proposals.[Applied to eBay]"] }, { title: "Suggested, approved, applied to eBay" }],
    ["barChart", [432, 180, 416, 240], { Category: ["Proposals.kind_label"], Y: ["Proposals.[Suggested]"], Series: ["Proposals.outcome"] }, { title: "Outcome by kind of change" }],
    ["clusteredBarChart", [856, 180, 408, 240], { Category: ["Proposals.decided_by"], Y: ["Proposals.[Approved]", "Proposals.[Rejected]"] }, { title: "Decisions by person" }],
    ["lineChart", [16, 428, 1248, 236], { Category: ["Calendar.Week Starting"], Y: ["Proposals.[Human Override Rate]"] }, { title: "Human override rate by week", sort: "Calendar.Week Starting" }],
    note("Every change to eBay needs a person. Human Override Rate is how often a person said no to the AI."),
  ]],
  ["health", "Listing health", [
    heading("Listing health"), dates,
    ...cards(["HealthFlags.[Flagged Listings]", "HealthFlags.[Flagged Then Changed]", "HealthFlags.[Flagged Then Sold]", "HealthFlags.[Flagged Sold Rate]"]),
    ["columnChart", [16, 180, 616, 240], { Category: ["Calendar.Week Starting"], Y: ["HealthFlags.[Flags]"], Series: ["HealthFlags.flag"] }, { title: "Flags by week", sort: "Calendar.Week Starting" }],
    ["tableEx", [640, 180, 624, 240], { Values: ["HealthFlags.title", "HealthFlags.flag", "min:HealthFlags.date", "max:HealthFlags.date", "HealthFlags.[Flags]"] }, { title: "Flagged listings (first and last day flagged)" }],
    ["tableEx", [16, 428, 1248, 236], { Values: ["Listings.title", "Listings.price", "Listings.days_listed", "Listings.watchers", "Listings.views_7d", "Listings.health_flags", "Listings.waiting_changes"] }, { title: "Live listings" }],
    note("Flags come from the nightly health check. Changed: a change was applied to eBay after the first flag. Sold: it sold after the first flag."),
  ]],
  ["cost", "AI cost", [
    heading("AI cost"), dates,
    ...cards(["ClaudeSpend.[Claude Cost $]", "ClaudeSpend.[Avg Daily Cost $]", "ClaudeSpend.[Budget Used]", "ClaudeSpend.[Days Over Budget]", "ClaudeSpend.[Cost per New Listing $]"]),
    ["lineClusteredColumnComboChart", [16, 180, 1248, 240], { Category: ["Calendar.Date"], Y: ["ClaudeSpend.[Claude Cost $]"], Y2: ["ClaudeSpend.[Budget Line $]"] }, { title: "Claude cost by day (line: daily budget)", sort: "Calendar.Date" }],
    ["clusteredBarChart", [16, 428, 616, 236], { Category: ["ClaudeSpend.job"], Y: ["ClaudeSpend.[Claude Cost $]"] }, { title: "Cost by job" }],
    ["clusteredBarChart", [640, 428, 624, 236], { Category: ["ClaudeSpend.model"], Y: ["ClaudeSpend.[Claude Cost $]"] }, { title: "Cost by model" }],
    note("Costs are what the app logged for each Claude call, in US dollars."),
  ]],
  ["sales", "Sales", [
    heading("Sales"), dates,
    ...cards(["Sales.[Revenue £]", "Sales.[Items Sold]", "Sales.[Avg Sale Price £]", "Sales.[Avg Days to Sell]", "Sales.[Sell-through]", "Listings.[Active Listings]"]),
    ["lineClusteredColumnComboChart", [16, 180, 616, 240], { Category: ["Calendar.Month"], Y: ["Sales.[Revenue £]"], Y2: ["Sales.[Items Sold]"] }, { title: "Revenue by month (line: items sold)", sort: "Calendar.Month" }],
    ["lineChart", [640, 180, 624, 240], { Category: ["ListingsDaily.date"], Y: ["sum:ListingsDaily.active_listings"], Y2: ["sum:ListingsDaily.asking_total"] }, { title: "Live listings and asking total", sort: "ListingsDaily.date" }],
    ["tableEx", [16, 428, 1248, 236], { Values: ["Sales.title", "Sales.sold_at", "Sales.item_price", "Sales.quantity", "Sales.days_to_sell", "Sales.source"] }, { title: "Sales" }],
    note("Sell-through is items sold in the period over items sold plus what is live now: a rough figure."),
  ]],
];

export function writeReport({ model }) {
  const out = {};
  const pages = PAGES.map(([name, displayName, visuals]) => page(name, displayName, visuals, model));
  for (const p of pages) for (const [path, text] of Object.entries(p.files)) out[`ShopHealth.Report/definition/${path}`] = text;
  out["ShopHealth.Report/definition/pages/pages.json"] = json({ $schema: `${SCHEMA}/pagesMetadata/1.0.0/schema.json`, pageOrder: pages.map((p) => p.pid), activePageName: pages[0].pid });
  out["ShopHealth.Report/definition/version.json"] = json({ $schema: `${SCHEMA}/versionMetadata/1.0.0/schema.json`, version: "2.0.0" });
  out["ShopHealth.Report/definition/report.json"] = json({
    $schema: `${SCHEMA}/report/3.0.0/schema.json`,
    themeCollection: { baseTheme: { name: "CY24SU10", reportVersionAtImport: { visual: "1.8.95", report: "2.0.95", page: "1.3.95" }, type: "SharedResources" } },
    resourcePackages: [{ name: "SharedResources", type: "SharedResources", items: [{ name: "CY24SU10", path: "BaseThemes/CY24SU10.json", type: "BaseTheme" }] }],
    settings: { useStylableVisualContainerHeader: true, exportDataMode: "AllowSummarized" },
  });
  out["ShopHealth.Report/definition.pbir"] = json({ $schema: "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json", version: "4.0", datasetReference: { byPath: { path: "../ShopHealth.SemanticModel" } } });
  return out;
}
