# Sold-price data without Marketplace Insights

eBay's Marketplace Insights API (the only official API for other sellers' sold prices) isn't available to this app. This doc explains why, what other developers do instead, and the approach EBayManager uses: an **estimated sold price** with a confidence level, from K's own sales, eBay's official data, and real sold records from two third-party providers (Trawl first or CompsAPI first, whichever wins K's test).

Researched 2026-11-02. Sources are listed at the end; vendor claims are marked as such.

## Why Marketplace Insights is out of reach

- **Limited release.** eBay describes it as a Limited Release API, available only to select developers approved by its business units ([eBay overview](https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html)).
- **The approval bar is a business case.** Applications are judged on the proposed business model, plus a formal agreement to eBay's Buy API requirements and an Application Growth Check before production access ([eBay: get started on a buying application](https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application)). A single seller managing their own listings isn't the kind of business case it's meant for.
- **Reportedly closed to new applicants.** One comparison page quotes eBay's docs as saying the API is "restricted and not open to new users at this time" ([SoldComps, vendor](https://sold-comps.com/alternatives)). A forum reply from eBay support says only to contact developer support with a use case ([eBay community](https://community.ebay.com/t5/eBay-APIs-Talk-to-your-fellow/Marketplace-Insights-API-access/m-p/34838736)), and one developer writes that "most applicants hear nothing" ([dev.to, vendor-written](https://dev.to/trawl/ebay-sold-listings-api-in-2026-findcompleteditems-is-gone-heres-what-still-works-2407)).
- **Limited even when granted.** 90 days of sales, and not every category ([eBay overview](https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html)).

**The old route is gone.** The Finding API's `findCompletedItems`, which used to return completed listings, was restricted from 2020. eBay decommissioned the whole Finding API in February 2025. Its suggested replacement, the Browse API, covers **active listings only** ([SoldComps, vendor](https://sold-comps.com/alternatives); [dev.to](https://dev.to/trawl/ebay-sold-listings-api-in-2026-findcompleteditems-is-gone-heres-what-still-works-2407)).

## What other developers do

| Approach | How it works | Sold prices? | Allowed by eBay? | Notes |
| --- | --- | --- | --- | --- |
| Terapeak (Seller Hub, Product Research) | eBay's own research dashboard, free for sellers | Averages: average sold price, price range, sell-through, units sold per listing. Up to about 3 years | Yes | **No API and no export**, browser only ([dev.to](https://dev.to/trawl/ebay-sold-listings-api-in-2026-findcompleteditems-is-gone-heres-what-still-works-2407)). No per-item price, date or condition ([SoldComps](https://sold-comps.com/alternatives)) |
| Scraping eBay's "sold items" pages yourself | Proxies, headless browsers, HTML parsing | Yes, about 90 days | **No.** eBay's User Agreement forbids robots and scrapers, and eBay actively blocks them | Breaks often (logins, CAPTCHAs, page changes). Ruled out: it puts K's account and API access at risk |
| Hosted sold-data APIs (SoldComps, CompsAPI, Apify actors) | A vendor scrapes eBay and sells the results | Yes, 90 days to about 3 years | No: SoldComps says it "runs the same scraping engine" | UK covered, from about $9 a month ([SoldComps](https://sold-comps.com/)). The ToS question moves to the vendor but doesn't go away |
| Sold-data databases (Trawl) | A vendor's database of completed sales | Yes: price, postage, condition, date. Covers ebay.co.uk | Unclear: the vendor doesn't say how the data is collected | Free tier ([dev.to, the vendor's own article](https://dev.to/trawl/ebay-sold-listings-api-in-2026-findcompleteditems-is-gone-heres-what-still-works-2407)) |
| Browse API, active listings | eBay's official search of live listings | No: asking prices only | Yes | What almost everyone falls back to. Asking prices run above sold prices |

## The EBayManager approach: an estimated sold price

EBayManager never scrapes eBay and never automates eBay's website. It combines six sources, scores how much they agree, and is honest about confidence. Decided by K on 2026-11-03: third-party sold records replace the manual Terapeak step.

### 1. K's own sales (strongest signal)

Every order K has had is in the Fulfillment API (`getOrders`), and the sold list is in `GetMyeBaySelling`. That gives the exact price, postage, date and item specifics. Accepted Best Offers show where buyers actually landed against the asking price. The first-day audit loads K's full history, and the nightly run keeps it current.

**Use:** identical or near-identical items K has sold give the sold price directly. Across all items, K's own ratio of "sold price to first asking price" and "days to sell at each price gap" calibrate everything below.

### 2. Live sales happening right now (`estimatedSoldQuantity`)

The Browse API's `getItem` returns `estimatedAvailabilities[].estimatedSoldQuantity` for live listings. For multi-quantity listings (common for new and refurbished items), that's **units sold at a known current price**, straight from eBay. The app records it daily for each tracked comparable. The day-to-day change is real sales volume at that price.

### 3. Tracking comparables over time (the market picture)

For each of K's items, the app searches Browse for **exact** comparables:
- the same product, by EPID or GTIN when known, otherwise a precise query checked by Claude;
- the same condition group;
- UK sellers, with prices compared **including postage**.

It saves them in `market_snapshots` and re-checks each one daily. From the history:
- **Supply:** how many comparables are listed now, and how many sellers.
- **Price ladder:** what the cheapest, lower-quartile and median comparables cost, postage included.
- **Probable sales:** a fixed-price comparable that ended well before its scheduled end, without a relist, probably sold at its last seen price. That's labelled "probable", never "sold". Auctions that ended with bids are recorded at their last seen bid as an indication only.
- **Price cuts:** comparables that dropped their price and still sit there show where the market won't buy.
- **Time on market at each price level:** this tells the app how fast items sell at different points on the ladder.

**Saturation** is calculated as weeks of supply: comparables listed now, divided by estimated sales per week. Sales per week comes from `estimatedSoldQuantity` changes plus probable sales.

### 4. Third-party sold records: Trawl and CompsAPI

Real sold listings for ebay.co.uk from two providers, used through `src/solddata.ts`:

| | Trawl (`api.trawl.dev/ebay/v1/sold`) | CompsAPI (`api.compsapi.com/v1/sold`) |
| --- | --- | --- |
| UK | `site=EBAY_GB`, prices in GBP | `site=UK`; prices in USD, GBP via `native_price=1` |
| Free tier, hard cap in code | 250 credits a month (1 per page of up to 100 sales; 0 for no results) | 100 requests a month |
| History | Years (not stated exactly) | 1 year (3 years from the $29 plan) |
| Best Offer | Sale price is the **listed** price, except in Collectibles, so these sales are left out of the estimate | Real accepted Best Offer price (`best_offer=1`) |
| Summary stats | Count only (the app calculates them) | Median, quartiles, mean |

**Which comes first is decided by K's test**, built as `src/solddata-eval.ts`:
1. Take 5 items K has actually sold, spread across the price range, from the real account's order history.
2. Ask each provider for the same item, using the same search words.
3. Leave K's own sale out of the results.
4. Compare each provider's median with what K actually got (the error), and whether K's price falls inside its middle 50% band.

The provider with the smaller average error becomes the primary; the other is the fallback. Coverage counts too: a provider that priced fewer than 3 of the 5 items can't win on accuracy alone. The test costs at most 5 searches per provider, the owner runs it from the app, and the result is kept so it can be re-run later.

**How they're used:**
- **Only when it matters:** for price changes, offer answers and new listings, never for routine checks.
- **The primary first.** The fallback is used only when the primary finds fewer than 3 true sales, or when the primary's monthly cap is used up.
- **Each search cached for 30 days,** so the same product never costs twice.
- **Junk dropped before the median:** lots, spares or repairs, faulty, box only, and outliers outside 1.5 times the interquartile range.
- **Only search words leave the app.** Never K's item numbers, account or buyers.

If both caps are used up, prices fall back to the other sources and their confidence drops, and the label says so.

### 5. Retail reference (only as a ceiling)

Only for an exactly identified product, Claude's web search finds the manufacturer's or a major retailer's current price, cited. It is used only so a used item is never priced above new, never as the price itself.

### Putting it together

| Input | Weight when present |
| --- | --- |
| K's own sales of the same product (last 12 months) | Highest |
| Third-party sold records, primary provider (median of true matches, same condition) | High |
| Third-party sold records, fallback provider | Medium-high |
| Prices with live sales (`estimatedSoldQuantity` rising) | High |
| Probable sales from tracking comparables | Medium |
| Low quartile of active comparables (postage-inclusive, condition-adjusted) | Medium: asking prices run above sold prices, so the low end is used |
| Retail price | Ceiling only |

The result is an **estimated sold-price band** (low, middle, high) with a **confidence** level:
- **High:** several independent sources agree within about 10%.
- **Medium:** sources partly agree.
- **Low:** one weak source, or under 3 true comparables.

The price target then follows [pricing-and-promotion.md](pricing-and-promotion.md): saturated markets price toward the low end, thin selling markets toward the middle. Low-confidence proposals say so in large type on the label, and the app never proposes a price on **no** evidence. In that case it asks K.

Every price and offer proposal shows its evidence:
- each source used, with links;
- the band and the confidence level;
- the weeks of supply;
- the expected days to sell;
- the profit after fees against the floor.

### What it can't do, honestly

- Third-party sold records depend on the providers' coverage and their free-tier caps. When both are used up, "probable sales" (inferences, labelled as such) carry more weight and confidence drops.
- For one-of-a-kind or rare items, true matches may be too few even in the providers' history. The app then relies on K's own history, or asks K.
- `estimatedSoldQuantity` only helps where sellers list multiple units. Used one-offs depend more on third-party sold records and tracking.

### Rules and trust

Neither provider is an official eBay API, and neither says how it collects its data (Trawl's terms say "publicly available information"). So:
- The app itself never touches eBay's website.
- Each provider works only if its key is set. The owner can remove either key at any time, and the rest of the pricing carries on.
- Their numbers are labelled by source on every proposal, next to K's own sales and eBay's data.

## Changes to the plan

- `docs/pricing-and-promotion.md`: Marketplace Insights is no longer expected. The market picture uses the five sources above.
- The allowlist gains Browse `getItem` for comparables (already allowed under `/buy/browse/v1/item/`). Nothing else is needed for sources 1 to 3.
- New data: `market_snapshots` (per item per day: comparables with price, postage, condition and `estimatedSoldQuantity`) and `comparable_tracking` (first seen, last seen, ended early, relisted).
- New data: `solddata_usage` (monthly usage per provider, the hard caps) and `solddata_cache` (30 days).
- Secrets: `TRAWL_API_KEY`, `COMPSAPI_KEY`. Hosts: `api.trawl.dev`, `api.compsapi.com`.

## Sources

- [eBay: Marketplace Insights API overview](https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html)
- [eBay: Get started on a buying application (Buy API requirements, Application Growth Check)](https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application)
- [eBay community: Marketplace Insights API access](https://community.ebay.com/t5/eBay-APIs-Talk-to-your-fellow/Marketplace-Insights-API-access/m-p/34838736)
- [dev.to: eBay sold listings API in 2026, findCompletedItems is gone (written by Trawl's founder)](https://dev.to/trawl/ebay-sold-listings-api-in-2026-findcompleteditems-is-gone-heres-what-still-works-2407)
- [SoldComps: eBay sold data API alternatives compared (vendor)](https://sold-comps.com/alternatives)
- [SoldComps: eBay sold listings API (vendor)](https://sold-comps.com/)
- [CompsAPI (vendor)](https://compsapi.com/), [CompsAPI docs](https://compsapi.com/docs)
- [Trawl docs](https://trawl.dev/docs), [Trawl sold endpoint](https://trawl.dev/docs/ebay/sold)
