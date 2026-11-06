# Listing assistant, first-day audit and reply style

The app assumes the person listing has never sold on eBay. It explains every step, never guesses a fact about an item, and asks when it can't find something out for certain.

Decided 2026-11-02.

## First-day audit (runs once the real account is connected)

A one-off, read-only review of the whole account, shown as a report in the app with a short summary pushed to K:

| Area | What it reads | What it reports |
| --- | --- | --- |
| Current listings | Every active listing in full: title, specifics, description, photos, price, postage, returns, Best Offer, promotion, views, watchers | Per listing: missing specifics, weak titles, thin descriptions, photo count and quality notes, price against the market picture, whether promotion would pay |
| Sold history | Sold listings and orders (Fulfillment `getOrders`, `GetMyeBaySelling` sold list) | What sells, at what price against the asking price, how fast, and fees as a share of revenue |
| Unsold and ended | Ended unsold listings | Why they likely didn't sell (price, title, photos, saturation) |
| Messages | Questions and K's past replies | K's reply style: tone, length, greeting and sign-off habits, typical answers. Saved as a style guide the drafts follow |
| Settings | Business policies (postage, returns, payment), handling time, item location | Whether they match K's rules (returns accepted, buyer pays return postage); anything unusual |

The audit makes **no** changes. Its suggestions become dry-run proposals in Phase 6, and real proposals once changes are on.

Built 2026-11-03 (`src/firstday.ts`). Price and promotion fixes come from the pricing engine and promotion research; return policies that break K's rule become `policy` proposals; titles, item specifics and descriptions go to the Claude listing review, which K starts per listing (or for all) from the Audit screen. Missing item specifics are checked against eBay's required and recommended aspects for each category (Taxonomy). eBay's sold and unsold lists only go back 60 days; older sales come from the imported Seller Hub report. Buyer IDs are never stored.

Updated 2026-11-03 after K's first run: the audit prices every listing with the engine (a pending listing edit no longer holds it back); postage of 0 counts as free only when eBay marks it free (otherwise eBay sets it per buyer); each listing gets revise-or-relist advice (revise when 3+ people watch it, relist after 90+ quiet days); K can add facts (measurements, faults, contents) and a floor per listing, which Claude uses and cites as "from K"; and dry-run proposals can be approved (recorded, never applied) or rejected. The style guide learns only from replies before a sale and never records typos, refunds or a price stance.

Updated 2026-11-05 (K's choice): the audit's findings are no longer a list on the Audit screen. What only K can do becomes an Inbox to-do ([approvals.md](approvals.md#to-dos-2026-11-05-ks-choice)), each worded as an instruction: answer a question (saved as K's facts), let Claude improve a listing (one per listing, grouping its title, specifics and description findings), or do something by hand. Fixes already filed as labels get no to-do. The Audit screen is a short summary with the figures folded away; K's facts and floor moved to Listings and the style guide to Settings. K's facts now also reach the pricing engine's identification, so answering its question lets it price the item.

Published specifications (`src/specs.ts`, 2026-11-03, K's request): for an exactly identified product, Sonnet with web search finds the manufacturer's dimensions, weight, model number and other specs, so K isn't asked to measure what's published. Each spec keeps its source page, and the code drops any spec whose source isn't a page that search returned, and all of them if the product isn't exactly identified. Stored per listing title in `product_specs`. The audit looks them up for each listing (once; about 3 to 6 cents each), the Claude listing review sees them as `PublishedSpecs`, and only what isn't published is left for K. A description that only repeats the title now counts as no description.

## Replies in K's voice

Reply drafts follow the style guide from the audit (and anything K edits later). The rules are unchanged: only facts from the listing, no price agreements, everything kept on eBay.

Built 2026-11-03 (`src/style.ts`): tone, length, greeting, sign-off, habits, example phrasings (item details replaced by placeholders) and things K avoids, stored in `settings.reply_style`. Contact details are scrubbed in code. It's added to the drafting prompts after the rules, which win where they conflict. Relearning never overwrites K's edits unless K asks.

## New listings from photos

### Taking the photos

Before the camera opens, the app shows a short checklist. It checks each photo as it's taken and says exactly what to retake and why:

- **Light:** daylight from a window, or two lamps either side. No flash, which causes glare and hard shadows. The item should be evenly lit, with no dark corners.
- **Background:** plain, uncluttered, and **the same one every time**. A white or light grey sheet, card or wall works, so every listing looks like it's from the same shop. The app shows a thumbnail of K's best past photos as the reference.
- **Framing:** the item fills most of the frame, straight on, with nothing else in shot. Photos are square or 4:3, at least 1600 px on the long side.
- **Shots per item type:** front, back, sides, top and bottom, labels, model number or serial plate, every accessory included, the box on all sides if there is one, and a close-up of **every flaw**. For clothes: flat lay front and back, the label, the size tag, and the fabric close up.
- **Scale:** something everyone knows the size of, when size matters.
- **Focus:** each photo is checked for blur, and the app asks for a retake rather than accepting a blurry shot.

### Filling in the facts: never assume

1. Claude identifies the item from the photos and any labels. **If it's certain of the exact product** (brand and model or barcode match), it may look up the manufacturer's specifications online: dimensions, weight, materials, original features. It cites where each fact came from, and K sees them.
2. **If it isn't certain,** it asks K a short, specific question, for example "Is this the 64 GB or the 128 GB model? The label is under the battery cover", instead of filling in a likely answer.
3. **Condition and flaws** always come from K and the photos, never from assumptions. The app asks K to confirm condition in plain words: works fully, any marks, anything missing.
4. **Required item specifics** for the category (eBay Taxonomy) are filled only from confirmed facts. Anything unknown is asked about.
5. The draft lists every fact with its source: "from the photo", "from K", or "from manufacturer page (link)".

### Price, postage, publish

- **Price:** from the market picture ([pricing-and-promotion.md](pricing-and-promotion.md)).
- **Postage:** K ships unless they say collection only. The app suggests a Royal Mail or courier service from the weight and size, which K confirms.
- **Returns:** accepted, with the buyer paying return postage.
- **Publish:** eBay checks the listing first (`VerifyAddFixedPriceItem`), then it's a proposal K approves, and only then is it published.

Photos are stored in Azure Blob Storage (Cloudflare R2 until the move on 2026-11-05; wired in with Phase 10) and uploaded to eBay when the listing is published.

### The app's New listing flow

Built (2026-11-06): the **New listing** wizard (`web/src/wizard.tsx`, at `/new`) runs on the drafts server (`/api/drafts`, `src/drafts.ts` and `src/newlisting.ts`). See [add-listing.md](add-listing.md) for the steps and [add-listing-handover.md](add-listing-handover.md) for its state. The placeholder `/api/listing-assistant/*` contract the wizard was first drawn against is gone.
