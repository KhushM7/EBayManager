# The pricing engine

The engine sets prices, answers offers and spots bundle opportunities. It doesn't pick a number from comparables. It works out **how likely an item is to sell at each price, how fast, and what K would keep**, then chooses the strategy with the best expected profit:
- **compete:** at the cheaper end of current sales, where the value isn't harmed;
- **hold:** at a higher price, when today's market is a temporary race to the bottom;
- **clear:** when value is falling for good.

It learns from every outcome. Every price is still a proposal K approves.

Designed 2026-11-03. It replaces the single "lower end of comparables" rule in [pricing-and-promotion.md](pricing-and-promotion.md) and uses the sources in [sold-price-data.md](sold-price-data.md).

## What the research says

| Finding | Source | How the engine uses it |
| --- | --- | --- |
| Sell-through matters more than matching the going price. 200 listed with 15 sold in 90 days is saturated, whatever the price | [SellerSupport](https://www.sellersupport.io/blog/ebay-pricing-strategy), [Privy](https://getprivy.co.uk/articles/ebay-pricing-strategy) | Saturation (weeks of supply) is a core input, not a footnote |
| Cheaper comparable listings sell first; pricing at the average leaves items sitting | [Privy](https://getprivy.co.uk/articles/ebay-pricing-strategy) | The sale-probability curve depends on the item's rank on the current price ladder |
| On eBay, sale probability depends on price relative to the item's value, not on price alone; a higher price means a lower sale probability but a higher expected price | [Einav et al.](https://pages.stern.nyu.edu/~tkuchler/PDF/EinavKuchlerLevinSundaresan_AEJMicro.pdf), [Levin et al.](https://web.stanford.edu/~jdlevin/Papers/AFP.pdf) | Price is modelled relative to market value |
| The price worth holding out for rises with how often buyers arrive and falls with the cost of waiting | [optimal stopping](https://arxiv.org/pdf/2609.23845); markdown research: [IJPR 2025](https://www.tandfonline.com/doi/full/10.1080/00207543.2025.2461133?af=R), [arXiv](https://arxiv.org/html/2608.23046v1) | The hold or sell decision is expected profit with a holding cost and impatience |
| Used goods depreciate steadily and drop 10–20% around new-model launches; a dip is only temporary once seasonality and depreciation are removed | [Swappa](https://swappa.com/blog/best-time-to-sell-electronics/), [mean reversion](https://en.wikipedia.org/wiki/Mean_reversion_(finance)), [regime models](https://arxiv.org/pdf/1909.05761) | Regime detection splits the trend, the season and the shock, and only holds when history shows recovery |

## The pipeline

```
listing ──► 1 Identify ──► 2 Gather ──► 3 Match ──► 4 Market state ──► 5 Sale model ──► 6 Decide ──► proposal
               │              │                                             ▲                │
               └─ bundle? ────┴─ price each component and add up            └── 7 Learn ◄────┘ outcomes
```

### 1. Identify the item (Claude Haiku, structured output)

From the listing (title, item specifics, description, condition), Claude returns:
- **Product identity:** brand, model, variant, and model number or GTIN when stated.
- **Components:** for a bundle ("keyboard + remote + manual"), each part with its own search, plus which parts carry value.
- **Search:** the words every match must contain (model numbers and digits kept, such as the "2" in Buds 2 Pro), and the words that mean a different product ("case for", "replacement", "Pro" when the item isn't a Pro).
- **Can it be priced?** If the title is too vague ("designer ceiling lights"), it says so and names what to ask K (brand, model, size). The engine then asks instead of guessing.

### 2. Gather

For each product or component:
- **Sold:** Trawl and CompsAPI are both used and **pooled**, with duplicates removed by eBay item number. Up to 2 years of history, each sale with its date. CompsAPI supplies the real Best Offer prices; Trawl adds depth.
- **Current supply:** eBay Browse active listings, with price, postage, condition, seller count, and `estimatedSoldQuantity` for live sales.
- **K's own sales and past listings,** including how long each took to sell.

The searches are cached for 30 days and capped per provider each month.

### 3. Match (Claude Haiku)

Each candidate sale or listing is checked against the identity: same product, model and variant, the same bundle contents (with or without the extras), and the same condition group. Accessories, parts, lots and other models are dropped. Claude gets the titles in batches of up to 100 and returns which ones match. This replaces the word-based junk filter, which wrongly dropped "Lot of 2 Pairs" and kept unrelated ceiling lights.

### 4. Market state

All prices are compared as **what the buyer pays in total** (price plus postage), because that's what buyers rank on. The engine calculates:

| Measure | How |
| --- | --- |
| Recent clearing price `m_now` | Median of matched sales in the last 30 days (60 if thin), condition-adjusted |
| Long-run price `m_long` | Median over 6 to 24 months, after the depreciation trend is removed |
| Depreciation trend | Robust slope (Theil–Sen) of log price against time over the full history |
| Seasonality | Month-of-year index, once there are at least 13 months of sales; otherwise none |
| Spread `s` | Interquartile range of recent sales |
| Demand `d` | Matched sales per week, over the last 4 weeks and the last 13 |
| Supply `n` | Matched active listings now, and the cheapest one |
| Saturation | Weeks of supply: `n / d` |
| Ladder | Sorted current active totals (where K's price would rank) |

**Regime.** Each item's market is classed as one of:
- **Normal:** recent prices sit within the usual band.
- **Race to the bottom:** `m_now` is well below `m_long` after trend and season (default more than 12%), with sales volume and supply both up. It's **temporary** if past dips in this product's history recovered within a few months (measured as a half-life from the de-trended series). Otherwise it's **structural**.
- **Structural decline:** a steady downward trend, or a new-model launch effect. Waiting loses money.
- **Thin:** fewer than 3 sales in 90 days. Low confidence; the engine prefers to ask K or to hold near `m_long`.

### 5. The sale model: how likely is it to sell at each price?

The chance of selling on any given day at total price `p` is modelled as:

```latex
h(p) = \frac{d \cdot \alpha}{n + 1} \cdot \frac{1}{1 + e^{(p - m)/\tau}}
```

- `d / (n + 1)` is K's fair share of current demand.
- The S-shaped curve gives cheaper prices (relative to the market price `m`) a bigger share.
- `τ` (how sensitive buyers are to price) and `α` (how well K's listings convert) are **learned** (step 7).

From `h(p)` the engine gets the **expected days to sell**, `1 / h(p)`, and the chance of selling within 7, 30 and 90 days.

### 6. Decide

For each candidate price, on a grid from the floor up to the ceiling, the expected value of listing at that price is:

```latex
V(p) = \frac{h(p)\,\big(\text{net}(p)\big) - c}{h(p) + \delta}
```

- `net(p)` is the price minus eBay's fees (0% final value fee for UK private sellers; set in Settings for business sellers) and minus any Promoted Listings rate.
- `c` is a small daily holding cost: storage, attention, and money tied up. Default 2p a day.
- `δ` is impatience. Default 0.1% a day, so £1 in 30 days is worth about 97p today.

The best price is the one that maximises `V(p)`. That's where "sell faster at a lower price" and "hold out for more" balance, under the current market.

**Strategies:**
- **Compete (normal market):** use the best price, kept inside the **cheaper half of current sales** (between their 25th and 55th percentile) so the listing is picked early. It never undercuts the cheapest true comparable by more than needed, and never goes below the floor or below "value harmed": the lower quartile of long-run sales.
- **Hold (temporary race to the bottom):** compare selling now in the crashed market with holding at the recovered price, using the forecast recovery and its half-life. Hold when holding's expected profit beats selling now by more than 10%, at a price that sells quickly once the market recovers. The proposal says "Hold at £X; the market is temporarily flooded and historically recovers in about N weeks". The engine re-checks nightly and switches as soon as the shock fades.
- **Clear (structural decline):** price for a quick sale now, because each week costs value.
- **Ask (thin or unidentified):** no price; a question to K.

Guardrails stay in code: K's floor, at most 10% per step unless K approves a larger jump, one change per 7 days, and nothing below the floor.

### 7. Learn: the evolvable part

The engine keeps a **record of every prediction**: price, regime, predicted days to sell, and expected profit. It then learns from what actually happens.

- **K's listings:** an item listed at a price relative to the market either sold after `t` days or is still unsold (a "censored" outcome). These outcomes update `τ` and `α` by maximum likelihood on the survival model.
- **The market's own listings:** comparables tracked daily on Browse that disappear early (probable sales), or keep sitting, with their price relative to the market. This gives many more examples of how fast items sell at each price point, and is how the engine learns quickly while K only sells about one item a month.
- **Parameters by category group:** each group (headphones, phone cases, home appliances and so on) has its own versioned parameters, shrunk toward the global ones when its data is thin, so one odd sale can't swing it.
- **Monitoring:** the Metrics screen shows predicted against actual days to sell, and the share of K's items that sold within their predicted window. If the model is consistently wrong in one direction, its parameters move. If accuracy drops, the engine falls back to the safe default (compete at the median of current sales) and says so.

### Bundles

**Pricing a bundle (K's request).** A listing with several items ("keyboard + remote + manual") is priced as the **sum of its components**, each found and matched separately. That's adjusted by:
- **Bundle effect:** only when real sales of the same bundle exist, comparing those against the sum of the parts. Otherwise there's no adjustment, and the label says it's the sum of parts.
- **Postage:** one parcel instead of several.

The proposal shows each component's price.

**Advice across K's listings** (nightly, using step 1 for each listing):
- **Combine:** two or more items that suit the same buyer (same brand or ecosystem, same use) and are slow or low in value, where one listing earns more than separate ones. One postage charge and one listing to manage; worth it when postage is a large share of each item's price.
- **Split:** a bundle whose parts would sell for clearly more on their own, after the extra postage and effort.
- **Group by appeal:** for traction, suggests pairing a slow item with a popular one (the Galaxy case with the Galaxy Buds).

Each suggestion shows the expected profit both ways and the expected days to sell. It's advice in the Inbox: K decides, and any listing changes it leads to are normal proposals.

## Data

| Table | Holds |
| --- | --- |
| `item_identity` | Claude's identification of each listing (product, components, searches), cached until the listing changes |
| `market_sales` | Pooled, matched sold records per product, with source, date, price, postage, condition and Best Offer flag |
| `market_snapshots` | Daily active supply per product (ladder, count, live sales) |
| `price_decisions` | Every decision: inputs, regime, strategy, price, predicted days and profit |
| `pricing_params` | Learned `τ` and `α` per category group, versioned, with the data count behind them |
| `bundle_advice` | Combine and split suggestions with the numbers |

## What K sees on a price label

- **The decision:** for example, "Compete: £34.50 (buyer pays £38.84 with postage)", "Hold at £42", or "Ask: which model is it?".
- **Why:** the regime in one sentence, with the clearing price, the long-run price, the weeks of supply and the trend.
- **Options:** three prices, each with expected days to sell and what K keeps.
- **Evidence:** links to the matched sales and current listings.
- **Confidence:** how many true matches there are, how well the sources agree, and the model's track record in this category.

## Revision 2 (2026-11-03): after K's first test, and further research

**What the first test showed:**
- Where the engine priced, it was close: 5.8% off on the 3D glasses and 16.8% on the sensor bin.
- But it refused to price whenever fewer than 3 exact matches existed.
- Claude guessed "new" for items whose title didn't say.
- A generic part ("Samsung TV remote") couldn't be found.
- A sale from May 2025 had almost no provider data before it.

**What real valuation and marketplace systems do, and what changed:**

| Practice | Source | Change |
| --- | --- | --- |
| Product matching on images and text together beats either alone; large catalogues resolve products with multimodal models | [Zalando](https://arxiv.org/pdf/2403.11593), [Shopify](https://ecommercefastlane.com/?p=177232), [vision-based second-hand pricing](https://arxiv.org/pdf/2012.06009) | Identification reads the title, item specifics, the full description and up to 3 listing photos. It records key facts with their source, and the condition is "unknown" unless a source says. About 0.05p a listing on Haiku. |
| Valuers pick comparable sales and **adjust the comparable, not the subject**; automated valuation blends comparables with a market index | [AVM methods](https://batchdata.io/blog/cma-vs-automated-valuation-models), [Realist AVM](https://support.mlsnow.com/hc/en-us/articles/7045096814363-Realist-Automated-Value-Model-AVM) | Claude grades each sale as **exact** or **close**. A close one gets a value factor (a pair vs one item, a 50L vs a 45L, new vs used). It is adjusted to K's item and counts 0.35 of an exact one. Depreciation is the market index. |
| With little data, borrow strength from related data (partial pooling, shrinkage); small samples are pulled toward a wider prior | [Empirical Bayes shrinkage](https://metricgate.com/docs/empirical-bayes-shrinkage/) | A thin market is priced from its few exact sales, pooled with the adjusted close ones and older sales brought to today's value. Confidence reflects the effective number of sales and the price spread. The engine asks K only when there is no evidence at all. |
| Airbnb's Smart Pricing estimates booking probability at each price, then sets prices within a band learned from outcomes | [Ye et al., KDD 2018](https://blog.acolyer.org/2018//03/customized-regression-model-for-airbnb-dynamic-pricing/) | Already the shape of the sale model and options: the chance of selling at each price, then a recommended price with quicker and higher options |
| On eBay Best Offer, round asking prices draw offers 6–11 days sooner but sell 5–8% lower; precise prices signal a patient seller | [Backus, Blake & Tadelis](https://faculty.haas.berkeley.edu/stadelis/round.pdf) | The ending follows the strategy. Hold uses a precise price (£41.85). Clear uses a round one (£37, or £60 above £50). Compete keeps .99/.49. |
| Overpricing lengthens time on market and doesn't pay; listings left too long are stigmatised | [Anglin, Rutherford & Springer](https://econpapers.repec.org/RePEc:kap:jrefec:v:26:y:2003:i:1:p:95-111), [Singapore condos](https://www.prres.org/volume10-2004/the-impact-of-pricing-on-time-on-market-in-high-rise-multiple-unit-residential-developments) | Holding costs double after a listing's 60th day, and the engine never advises holding beyond 120 days |
| Buyers on eBay search on price, and ranking rewards listings that sell | [Dinerstein et al., AER 2018](https://nber.org/papers/w20415), [eBay Best Match](https://www.ebay.co.uk/help/selling/listings/listing-tips/optimising-listings-best-match?id=4166) | Supports compete pricing at the cheaper end of current sales, and the staleness cost |
| Mercari prices from similar items' sales, with the lowest observed sale as a guard | [Mercari](https://medium.com/mercari-engineering/price-guidance-system-74358bd96081) | The "value floor" (lower quartile of long-run sales) plays that role |

**Considered and not adopted, for now:**
- **Thompson sampling** ([Ferreira, Simchi-Levi & Wang](https://dspace.mit.edu/handle/1721.1/125757)) learns demand by experimenting with prices. K sells about one item a month, so experimenting on K's own listings would cost more than it teaches. Watching competitors' listings sell or sit (step 7) gives the same learning without the cost.
- **A hedonic regression across all products** needs thousands of sales per category. Per-item comparables with adjustments are traceable and work with a handful.

**The comparison test** now prefers K's sales from the last 11 months, which the providers' data covers. Older sales are marked as such. Where eBay still has a sold listing, Claude reads its description and photos too.

## Offers, audits and the nightly check (2026-11-03)

Every price decision now goes through the engine, enforced in code.

**Best Offers** (`src/pricing/offers.ts`, from the 15-minute inbox poll). The engine works out K's **reservation value**: what carrying on is worth now, meaning listing at its recommended price and waiting the expected time for a buyer, less the holding cost and impatience. It never goes below K's floor or the item's long-run value floor. Then:
- **Accept** when the offer is at least the reservation value.
- **Counter** when it's below. The counter is at the reservation value, or halfway to the asking price if that's higher, never above the asking price, and with a precise ending (a precise counter signals a firm seller).
- **Decline** an offer under half the reservation value. K can still counter from the Inbox.

The engine's last check is used if it's under 3 days old, otherwise a fresh one runs. Claude only writes the short message to the buyer, which matches the decided answer. The simple old guide (accept within 5%, otherwise meet halfway) is used only when the engine has no market for the item, and the label says so. K approves every response.

**Audits and nightly triage.** `propose_price_change` refuses any price that isn't one of the engine's three options (within 1%) from a check in the last 3 days. It also refuses when the engine is asking K a question instead. The engine's strategy and reasoning are attached to the proposal.

**Nightly price review** (`src/pricing/review.ts`). Each night the engine re-prices up to 5 listings, the least recently checked first. It skips any listing with a pending proposal or a price change in the last 7 days. It files a proposal where the change is at least 5% and its confidence is at least 30%. This keeps the sold-data searches well inside the monthly caps.

## Revision 3 (2026-11-05): after K's first nightly on Azure

From K's review of the first real labels:

- **Postage above the typical.** K sets postage on the high side for big items, offers collection, and refunds overpaid postage. When K's postage is above the market's typical postage, the engine prices as if the typical postage were charged (`pricingPostage`), and the label says so. Before, the Dyson's £18 postage (typical £6.38) pushed its target down to £13.99.
- **One known, simple fault.** Identification now reads `fault` for spares or repair items: `minor` (one named fault with a simple fix, the rest stated working), `major` or `unknown` (`IDENTITY_VERSION` 4). A minor-fault item competes from the middle of spares sales to halfway to the upper quartile, not the cheaper half: it's better than the typical spares listing, whose faults are unknown. With the Dyson's market (middle £33, upper quartile £39.70 in totals) that's about £29.99 plus postage. K's own sale of the same model with the same fault (2026-05-11, £18.60 in total) suggests posted sales may still go lower; the adjustment is kept modest for that reason.
- **No comparable sales: K's price.** The engine asks "which model?" only when it can't tell what the item is (`reason: "unidentified"`). When it knows but nothing comparable has sold (`reason: "no_sales"`), the Inbox asks K for a price. The answer becomes the listing's own price (`own_price` in item settings, strategy `own`): recorded as the engine's decision, never re-proposed or moved, and cleared from the facts box on Listings. If the listing isn't at it, the usual price proposal (floor, step and engine checks) files a label. An own-priced listing isn't forgotten (K's request): about once a week, during the nightly review, the engine looks again for a market (`priceOwned`), and as soon as sales of the item or something close appear it lifts K's price, pushes "A market for your item appeared" and prices it again, so the review proposes its price the same night. After 30 days unsold the Inbox asks K to review the price ("Review your price: no sale in N days", with watchers and views); an answer sets a new own price with a label, and a dismissal brings it back after the next 30 days.
- **Readable waits.** Estimates over a year are shown as "no reliable estimate" (`daysText`), and the weighted count of competing listings is rounded (`listed`).
- **No repeats while changes are off.** An approved dry run doesn't change eBay, so the nightly would propose the same change again, or undo it (a triage edit put back specifics a review had removed). Triage no longer proposes a listing edit or a price change for a listing that had one in the last 7 days (waiting, approved, agreed as a dry run, or applied), and the nightly price review holds a listing with a price change agreed in the last 7 days.

## Revision 4 (2026-11-06): K's seller rule

K's first real item (an opened, never-used Silvercrest air fryer) showed the engine didn't price like a seller. Two new sales at £28.12 and £37.73 and one used sale at £12.79 came out at £10.99 to £21.99. Three causes, all in the code:

- Live listings never set the price: `decide()` used them only as a count in the sale-rate model, never the cheapest one, and had no notion of an overpriced listing. So even on the real account it wouldn't have aimed under the cheapest competitor.
- Close and different-condition matches always counted (at 0.35), so a used sale weighed on an unused item's price.
- A trend was fitted through as few as 3 sales, and the most recent (the used one) dominated.

K's rule, now `sellerTarget()` in `model.ts`, used for an ordinary sale (not a falling market, a temporary dip worth holding through, or spares with one known fault, which keep their rules):

1. **What buyers pay** comes from same-condition sales (exact matches) only, when there are any. Under 6 such sales, the value is their middle and the range is lowest to dearest; from 6, the recent median and quartiles. No trend through fewer than 6.
2. **Overpriced listings are ignored**: same-condition listings above 1.3 times the value, or 15% above the dearest sale. Nobody buys at £55 what sells at £28 to £37.
3. **With realistic competition**: just under the cheapest (by the larger of 50p and 1.5%, at the nearest .49/.99 ending at least 25p under it), even above past sales.
4. **Never below the lowest same-condition sale** (the lower quartile with many) to chase a cheap listing: then it holds there and says why.
5. **No realistic competition**: priced at what buyers pay.
6. **No sales but same-condition listings**: just under the cheapest realistic one, low confidence.

The air fryer now prices at £32.49 (the middle of the two new sales), with the used sale set aside and the label saying so. Tests: `test/pricing-seller.test.ts`, one per case above, on the air fryer's numbers.

The nightly price review applies the same rule to live listings every night: as competitors list, sell or change price, the target moves (within the 10% step and the 7-day rule), and the sale model keeps learning how fast K's items sell at each price.
