# Pricing, offers and promotion

Every price, offer answer and ad rate is a proposal K approves. The research behind each one goes much further than one search. It builds a market picture of what the same item in the same condition is listed for and has sold for, and how crowded that market is. The aim is the most profit that still sells the item quickly.

Decided 2026-11-02. eBay's Marketplace Insights API isn't available to this app, so sold prices are **estimated** from sanctioned sources only, with a confidence level: see [sold-price-data.md](sold-price-data.md).

## The market picture

For each item, the app builds a **market picture**, stored with every price proposal so K can see the evidence behind it:

1. **Identify the item exactly.** Brand, model, edition or year, and the attributes that change value (size, colour, capacity), from the listing's item specifics and eBay's catalogue (`getItemAspectsForCategory`). If the item can't be pinned down, the app asks K rather than guessing.
2. **Find comparables.** eBay Browse `search` by the exact product (EPID or GTIN when known, else a precise keyword query), the same category, UK sellers, and the same condition group. It runs several searches (exact, slightly broader, other conditions) and keeps only true matches. Claude checks each candidate's title and specifics and drops accessories, parts, bundles and wrong models.
3. **Price on the buyer's total.** Each comparable's price **plus postage** is what buyers compare, so it's normalised that way, separately for collection-only items.
4. **Condition adjustment.** Comparables in other conditions are adjusted with stated ratios (new, like new, very good, good, acceptable, for parts), calibrated from the comparables themselves when there are enough.
5. **Estimated sold prices.** From K's own sales, live sales on comparable listings (`estimatedSoldQuantity`), comparables tracked over time, Terapeak figures K enters when confidence is low and the item is worth it, and the low end of active listings. Each proposal shows the band, its confidence and its sources ([sold-price-data.md](sold-price-data.md)).
6. **Saturation.** The number of active comparables, against how many sold recently (sell-through), and how many sellers there are. A crowded market with few sales pushes the price to the low end and favours promotion; a thin market with steady sales allows the upper middle.
7. **Original retail price and specifications** from manufacturer or retailer pages (Claude web search, cited) when the product is identified exactly. They're used only as a ceiling and for facts, never as the price.

## From picture to proposal

| Market | Signal | Price target (buyer's total, with postage) |
| --- | --- | --- |
| Thin, selling | Few active comparables, recent sales | Median of sold prices, upper end if condition is better than most |
| Normal | Steady supply and sales | Lower-middle of sold prices (K's rule: lower end of comparable sold prices, adjusted for condition) |
| Saturated | Many active comparables, low sell-through | Just under the cheapest comparable in the same condition, within the floor |
| No data | Under 3 true comparables | No price proposal; the app asks K, with what it found |

Every price proposal shows:
- the comparables used, with links;
- the sold prices and where they came from;
- the saturation level;
- the expected days to sell;
- the profit after eBay fees and postage, against K's floor.

Guardrails stay: at most 10% per step, one change per 7 days, never below the floor, all flagged for K.

## Offers and counters

Offer answers use the same market picture:
- **Accept** at or above the target.
- **Counter** between the offer and the target, never below the floor or the target minus the room the market allows.
- **Decline** below the floor, with a counter when the buyer seems genuine.

The suggestion shows the profit at the offered price and at the counter. Replies and offer answers always need K's approval and are never auto-applied.

## Promoted Listings

eBay's suggested ad rate is usually high. The app proposes promotion only when it's worth paying for:

- **When:** the market is saturated (many active comparables) **and** the listing gets few impressions or clicks for its age; or an item has sat 30+ days with steady views but no sale.
- **Never:** in thin markets where the item already shows near the top, or when the extra margin can't cover the fee.
- **Rate:** "general" (cost per sale) campaigns only, so K pays only when an item sells through the ad. The proposed rate is the lowest that's likely to help, normally 2 to 4%, and well below eBay's suggestion: never more than half of it, and never above what the profit after fees allows. The proposal shows eBay's suggested rate next to it.
- **Review:** after 14 days the app compares impressions and clicks before and after, and proposes lowering or ending a promotion that isn't paying back.

## Data the app keeps

`market_snapshots(item_id, taken_at, query, comparables JSON, sold JSON, saturation, target, confidence)`, so every proposal's evidence can be reopened later, and so the app learns how fast items at each price point actually sell.
