# Sold-price data without Marketplace Insights

eBay's Marketplace Insights API (the only official API for other sellers' sold prices) isn't available to this app. This doc explains why, what other developers do instead, and the approach EBayManager uses: an **estimated sold price** built only from data eBay sanctions, plus a confidence level, with K asked for a Terapeak check when confidence is low and the item is worth it.

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

## The EBayManager approach: an estimated sold price from sanctioned data

EBayManager never scrapes eBay and never automates eBay's website. It combines five sources that eBay allows, scores how much they agree, and is honest about confidence.

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

### 4. Terapeak, by K, when it matters

Terapeak is the only official market-wide sold history, and it has no API. The app makes it a 30-second step for K, not an automation:
- When confidence is low **and** the item's value is above a threshold (default £40, set in Settings), the price proposal includes a **"Check Terapeak"** button. It opens Seller Hub's Product Research already filled with the item's search, on the UK site and the last 90 days.
- K types in the two numbers Terapeak shows (average sold price and sell-through), or skips the step. The app then recalculates the proposal on the spot.
- The numbers are saved with the market picture, so the same product isn't asked about again for 30 days.

### 5. Retail reference (only as a ceiling)

Only for an exactly identified product, Claude's web search finds the manufacturer's or a major retailer's current price, cited. It is used only so a used item is never priced above new, never as the price itself.

### Putting it together

| Input | Weight when present |
| --- | --- |
| K's own sales of the same product (last 12 months) | Highest |
| Terapeak average sold price (entered by K) | High |
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

- It can't see other sellers' exact sold prices market-wide without Terapeak. "Probable sales" are inferences, labelled as such.
- For one-of-a-kind or rare items, comparables may be too few. The app then relies on K's own history and Terapeak, or asks K.
- `estimatedSoldQuantity` only helps where sellers list multiple units. Used one-offs depend more on tracking and Terapeak.

### An optional extra K can choose later (off by default)

A hosted sold-data API (for example SoldComps or Trawl, both covering ebay.co.uk with free tiers) would add exact sold records. It's **off by default**, for two reasons:
- these services get their data by scraping eBay or don't say how they get it, which conflicts with eBay's rules even though EBayManager wouldn't be the one scraping;
- adding one means a third party receives the app's search queries. It would never receive K's eBay credentials.

If K wants it, the plan is:
- an owner-only switch;
- the vendor's host added to the allowlist and the CSP connect list;
- its numbers shown separately, labelled "third-party estimate", with the lowest weight in the table above.

## Changes to the plan

- `docs/pricing-and-promotion.md`: Marketplace Insights is no longer expected. The market picture uses the five sources above.
- The allowlist gains Browse `getItem` for comparables (already allowed under `/buy/browse/v1/item/`). Nothing else is needed for sources 1 to 3.
- New data: `market_snapshots` (per item per day: comparables with price, postage, condition and `estimatedSoldQuantity`), `comparable_tracking` (first seen, last seen, ended early, relisted) and `terapeak_checks` (K's entries).
- Settings: the Terapeak threshold (default £40), and later the third-party data switch (off).

## Sources

- [eBay: Marketplace Insights API overview](https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html)
- [eBay: Get started on a buying application (Buy API requirements, Application Growth Check)](https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application)
- [eBay community: Marketplace Insights API access](https://community.ebay.com/t5/eBay-APIs-Talk-to-your-fellow/Marketplace-Insights-API-access/m-p/34838736)
- [dev.to: eBay sold listings API in 2026, findCompletedItems is gone (written by Trawl's founder)](https://dev.to/trawl/ebay-sold-listings-api-in-2026-findcompleteditems-is-gone-heres-what-still-works-2407)
- [SoldComps: eBay sold data API alternatives compared (vendor)](https://sold-comps.com/alternatives)
- [SoldComps: eBay sold listings API (vendor)](https://sold-comps.com/)
- [CompsAPI (vendor)](https://compsapi.com/)
