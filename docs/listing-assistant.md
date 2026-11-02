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

## Replies in K's voice

Reply drafts follow the style guide from the audit (and anything K edits later). The rules are unchanged: only facts from the listing, no price agreements, everything kept on eBay.

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

Photos are stored in Cloudflare R2 (enabled 2026-11-02) and uploaded to eBay when the listing is published.
