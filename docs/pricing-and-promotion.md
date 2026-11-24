# Pricing, offers and promotion

> **2026-11-03:** how a price is chosen is now set out in [pricing-engine.md](pricing-engine.md), which replaces the fixed rule in the table below. Offers and promotion here still apply.

Every price, offer answer and ad rate is a proposal K approves. The research behind each one goes much further than one search. It builds a market picture of what the same item in the same condition is listed for and has sold for, and how crowded that market is. The aim is the most profit that still sells the item quickly.

Decided 2026-11-02. eBay's Marketplace Insights API isn't available to this app, so sold prices are **estimated** from sanctioned sources only, with a confidence level: see [sold-price-data.md](sold-price-data.md).

## The market picture

For each item, the app builds a **market picture**, stored with every price proposal so K can see the evidence behind it:

1. **Identify the item exactly.** Brand, model, edition or year, and the attributes that change value (size, colour, capacity), from the listing's item specifics and eBay's catalogue (`getItemAspectsForCategory`). If the item can't be pinned down, the app asks K rather than guessing.
2. **Find comparables.** eBay Browse `search` by the exact product (EPID or GTIN when known, else a precise keyword query), the same category, UK sellers, and the same condition group. It runs several searches (exact, slightly broader, other conditions) and keeps only true matches. Claude checks each candidate's title and specifics and drops accessories, parts, bundles and wrong models.
3. **Price on the buyer's total.** Each comparable's price **plus postage** is what buyers compare, so it's normalised that way, separately for collection-only items.
4. **Condition adjustment.** Comparables in other conditions are adjusted with stated ratios (new, like new, very good, good, acceptable, for parts), calibrated from the comparables themselves when there are enough.
5. **Estimated sold prices.** From K's own sales, live sales on comparable listings (`estimatedSoldQuantity`), comparables tracked over time, real sold records from Trawl or CompsAPI (whichever wins K's test), and the low end of active listings. Each proposal shows the band, its confidence and its sources ([sold-price-data.md](sold-price-data.md)).
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

**Built 2026-11-03** (`src/promotion.ts`). Saturated means 6+ weeks of supply (or 8+ matching listings with no recent sales), never a thin market. The rate is 40% of eBay's suggestion in half points, between 2% and 4%, never more than half the suggestion; if half the suggestion is under eBay's 2% minimum, there's no proposal. It must pay back: with the engine's sale model, a promoted listing is assumed 25% more likely to sell each day (a deliberately modest assumption until 14-day reviews measure it), the ad fee is charged on every sale (conservative), and the expected value must rise by at least 25p. The fee can never take the sale under K's floor. A listing already promoted above the limit gets a "lower" proposal, and one in a market where promotion can't pay gets an "end" proposal. The 14-day before-and-after review is still to do. eBay's suggested rates (Recommendation API) need the full `sell.inventory` scope, so while the account is read-only the cap falls back to 2%, and eBay gives no suggestion for listings already in a campaign.

## Data the app keeps

`market_snapshots(item_id, taken_at, query, comparables JSON, sold JSON, saturation, target, confidence)`, so every proposal's evidence can be reopened later, and so the app learns how fast items at each price point actually sell.

## 2026-11-15: promotion by views and watchers, applied through the gate; offers to watchers

- **When promotion is proposed** (K): when the listing isn't being seen, not for days listed alone. Not seen means under 100 search impressions in 7 days (a week or more listed), or fewer than 5 views in 7 days with nobody watching after 14 days. A listing with views and watchers doesn't need an ad however long it has sat: its lever is the price or an offer to its watchers. A saturated market is no longer required, only that the market isn't thin; the rate limits, the payback test and the floor check are unchanged.
- **Applying it**: an approved `promote` label now changes eBay (`src/ebay/write.ts`, `applyPromotion`): the listing's ad is created in the app's one general campaign ("EBayManager general", made on first use), its rate changed, or the ad removed. The gate refuses a rate outside 2% to 4%.
- **Offers to watchers** (`src/watchers.ts`, K): a reminder to people who liked the item, so the discount is as small as possible: 5%, eBay's minimum and K's maximum (changed 2026-11-24: the 2% to 5% for 4 days written here first is outside eBay's specification), never under K's floor. Nightly, for listings eBay says are eligible, at least 7 days listed, with no price change under way and no offer in the last 14 days. Each is an `offer_to_watchers` label K approves; offers run 2 days with no counter-offers. The gate refuses any other discount.
- **Not yet proven on eBay.** The Marketing and Negotiation calls were written without access to eBay's API reference from the build session. Prove each once on Sandbox, then with one real label on production, before relying on them. 
## 2026-11-15: the sales ladder and the 14-day promotion review

- **The sales ladder** (`src/ladder.ts`). One push per listing at a time, at most one a week, the one its figures call for. Nobody sees it (under 5 views in 7 days with nobody watching after 14 days, or under 100 search impressions): the title and item specifics first; if they were improved in the last 30 days and it's still unseen, promotion; with an ad too, the price. People watch it but don't buy: a small offer to the watchers; if one went out in the last 14 days, the price. People see it but nobody watches after 14 days: the price. The nightly works the rungs out once and each step (price review, triage, offers to watchers, promotion) acts only on its own; a price change of 10% or more is proposed whatever the rung, since the market has moved. Listings whose flags call for a step triage can't take aren't sent to Claude that night.
- **The 14-day review** (`promotionReview`, `reviewRunningPromotions`). A promotion label now records the listing's views, impressions and watchers when it was proposed. Fourteen days after the ad is applied, and every 14 days while it runs, tonight's figures are compared with those: working means impressions up a quarter, views up by half and at least 3, or someone new watching. If not, an "end" label is filed with the figures; if so, it stays, and tonight's figures become the starting point for the next review. A promoted listing is no longer ended by the nightly advice just because it's being seen (that is the ad working), and its payback is no longer re-judged from the sale model: only its rate is brought down if above the limit.

## 2026-11-24: the ladder passes over dead steps; offers to watchers are 5% for 2 days

- **Feasibility.** Before the rungs are worked out, the nightly asks eBay which listings can be offered to watchers and checks promotion advice, once, and each later step uses the same answers. A rung that can't do anything tonight is passed over: no Claude, or Claude looked in the last 30 days and had nothing to change (listing); eBay says the listing isn't eligible, or 5% off is under the floor (offer); no market or payback (promote); K's own price, or a check in the last 6 days with no confident change of 5% or more (price). Unseen: listing, promote, price. Watched: offer, price. Nothing possible: nothing is said. If a check fails, the listing waits; it never falls through to a price cut because a call failed.
- **Triage** takes up to 5 listings it can act on, least recently looked at first, including listings on the "listing" step that no health rule flagged. One failing doesn't stop the rest.
- **Offers to watchers.** eBay's Negotiation API specification says `discountPercentage` is at least 5 and the duration must be 2 days, so every 2% to 4%, 4-day offer would have been refused. Inside K's 5% maximum that leaves 5% for 2 days. Each night records eBay's reply to findEligibleItems (204, or the fields sent), to settle why it listed nothing from 16 to 24 November.
