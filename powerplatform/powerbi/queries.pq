// Power Query (M) for the Shop Health report. Written by build.mjs: change that, not this.
// Each block is one query; its name is the comment above it. BaseUrl and ApiKey are text parameters.

// BaseUrl (parameter, text): the app's address, with no slash at the end
"https://ebay-autopilot-sandbox-wrpoyt.azurewebsites.net"

// ApiKey (parameter, text): the read-only key (RO_API_KEY). Never save it in a file you share
""

// fnExport (function)
(name as text) as table =>
let
    // The key goes in a header, so the data source's credential in Power BI is "Anonymous".
    Raw = Web.Contents(BaseUrl, [RelativePath = "api/ro/export/" & name & ".csv", Headers = [#"X-Api-Key" = ApiKey]]),
    Csv = Csv.Document(Raw, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(Csv, [PromoteAllScalars = true])
in
    Promoted

// Calendar
let
    Start = #date(2025, 1, 1),
    End = Date.EndOfYear(Date.From(DateTime.LocalNow())),
    Days = List.Dates(Start, Duration.Days(End - Start) + 1, #duration(1, 0, 0, 0)),
    AsTable = Table.FromList(Days, Splitter.SplitByNothing(), {"Date"}),
    Typed = Table.TransformColumnTypes(AsTable, {{"Date", type date}}),
    Year = Table.AddColumn(Typed, "Year", each Date.Year([Date]), Int64.Type),
    Month = Table.AddColumn(Year, "Month", each Date.ToText([Date], "yyyy-MM"), type text),
    Week = Table.AddColumn(Month, "Week Starting", each Date.StartOfWeek([Date], Day.Monday), type date)
in
    Week

// listings
let
    Source = fnExport("listings"),
    Typed = Table.TransformColumnTypes(Source, {{"item_id", type text}, {"title", type text}, {"price", type number}, {"currency", type text}, {"quantity", Int64.Type}, {"watchers", Int64.Type}, {"views_7d", Int64.Type}, {"impressions_7d", Int64.Type}, {"start_date", type datetimezone}, {"days_listed", Int64.Type}, {"health_flags", type text}, {"waiting_changes", Int64.Type}, {"snapshot_at", type datetimezone}}, "en-GB")
in
    Typed

// listings_daily
let
    Source = fnExport("listings_daily"),
    Typed = Table.TransformColumnTypes(Source, {{"date", type date}, {"active_listings", Int64.Type}, {"asking_total", type number}, {"watchers", Int64.Type}}, "en-GB")
in
    Typed

// sales
let
    Source = fnExport("sales"),
    Typed = Table.TransformColumnTypes(Source, {{"sale_id", type text}, {"sold_at", type datetimezone}, {"item_id", type text}, {"title", type text}, {"quantity", Int64.Type}, {"item_price", type number}, {"line_total", type number}, {"days_to_sell", type number}, {"source", type text}}, "en-GB"),
    WithDate = Table.AddColumn(Typed, "sold_date", each Date.From(DateTimeZone.ToUtc([sold_at])), type date)
in
    WithDate

// proposals
let
    Source = fnExport("proposals"),
    Typed = Table.TransformColumnTypes(Source, {{"id", type text}, {"kind", type text}, {"kind_label", type text}, {"item_id", type text}, {"item_title", type text}, {"status", type text}, {"outcome", type text}, {"applied", type logical}, {"dry_run", type logical}, {"created_at", type datetimezone}, {"decided_at", type datetimezone}, {"expires_at", type datetimezone}, {"hours_to_decide", type number}, {"decided_by", type text}, {"old_price", type number}, {"new_price", type number}}, "en-GB"),
    WithDate = Table.AddColumn(Typed, "created_date", each Date.From(DateTimeZone.ToUtc([created_at])), type date)
in
    WithDate

// price_accuracy
let
    Source = fnExport("price_accuracy"),
    Typed = Table.TransformColumnTypes(Source, {{"sale_id", type text}, {"sold_at", type datetimezone}, {"item_id", type text}, {"title", type text}, {"group", type text}, {"strategy", type text}, {"predicted_at", type datetimezone}, {"days_before_sale", type number}, {"predicted_price", type number}, {"market_price", type number}, {"sold_price", type number}, {"error", type number}, {"abs_pct_error", type number}}, "en-GB"),
    WithDate = Table.AddColumn(Typed, "sold_date", each Date.From(DateTimeZone.ToUtc([sold_at])), type date)
in
    WithDate

// price_decisions
let
    Source = fnExport("price_decisions"),
    Typed = Table.TransformColumnTypes(Source, {{"item_id", type text}, {"decided_at", type datetimezone}, {"group", type text}, {"strategy", type text}, {"suggested_price", type number}, {"suggested_total_with_postage", type number}, {"market_price", type number}, {"predicted_days", type number}}, "en-GB"),
    WithDate = Table.AddColumn(Typed, "decided_date", each Date.From(DateTimeZone.ToUtc([decided_at])), type date)
in
    WithDate

// health_flags
let
    Source = fnExport("health_flags"),
    Typed = Table.TransformColumnTypes(Source, {{"date", type date}, {"item_id", type text}, {"title", type text}, {"flag", type text}, {"detail", type text}}, "en-GB")
in
    Typed

// claude_spend
let
    Source = fnExport("claude_spend"),
    Typed = Table.TransformColumnTypes(Source, {{"date", type date}, {"job", type text}, {"model", type text}, {"calls", Int64.Type}, {"input_tokens", Int64.Type}, {"output_tokens", Int64.Type}, {"cost_usd", type number}, {"daily_budget_usd", type number}}, "en-GB")
in
    Typed
