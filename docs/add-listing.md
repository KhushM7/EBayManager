# Add Listing: plan

K's request (2026-11-05): build and finish **Add Listing** before going live. Status: **L1 to L5 built and tested with stand-ins** (on the `add-listing` branch, 2026-11-05), not yet deployed or tried with real photos. What's done, what K needs to test, and what's left: [add-listing-handover.md](add-listing-handover.md). K's decisions are at the end of this doc. Design principles stay those of [listing-assistant.md](listing-assistant.md): coach the photos, never assume a fact, price from the market, and nothing is listed until K approves.

## What already exists

| Piece | Where | State |
| --- | --- | --- |
| The `create_listing` proposal kind and its builder (`AddFixedPriceItem`: title, description, category, price, condition, specifics, Best Offer, returns rule, postage or collection only) | `src/ebay/write.ts` | Built, applied on Sandbox. Locked kind: never auto-applied |
| eBay's check before K sees it (`VerifyAddFixedPriceItem`, fees shown) | `src/ebay/write.ts`, `propose_new_listing` in `src/tools.ts` | Built (MCP tool only, no screen) |
| Identification from title, description, photos and K's facts; published specs with sources; required and recommended item specifics per category | `src/pricing/identify.ts`, `src/specs.ts`, `src/ebay/browse.ts` | Built for existing listings |
| The pricing engine (works on any item, not just live listings), own price when nothing has sold | `src/pricing/` | Built |
| K's reply style guide (for the description's voice) | `src/style.ts` | Built |
| Private photo storage | `photos` Blob container, no public access, the app's identity has access | Created by Bicep; not used yet |

## What's missing

Screens, photo handling, the guided flow, category choice, postage, drafts, and sending photos to eBay.

## The flow (phone first; the same on desktop)

1. **Photos.** "New listing" opens a checklist (light, plain background, the same one each time, framing, the shots this kind of item needs), then the camera or a file picker. Each photo is checked **on the phone, instantly and free**: resolution (at least 1600 px), brightness, blur, a duplicate. A bad one gets "Retake: too dark, try daylight from a window." Photos are resized to at most 2400 px and **location data (EXIF GPS) is stripped** before upload, then stored privately in Blob Storage under the draft.
2. **Photo review.** One Claude (Sonnet) look at the whole set: what the item is, and which shots are missing for this kind of item (label or model number, every side, every accessory, every flaw, the box), each with why. K adds them or carries on.
3. **Facts, never assumed.** Claude identifies the item. Exactly identified: published specifications are looked up, each with its source. A short form then asks only what K alone knows: condition in plain words, does it fully work, any marks, what's included, anything missing. Every fact in the draft shows its source: "photo", "from you", or "manufacturer page (link)".
4. **Category and specifics.** eBay's category suggestions for the item (Taxonomy, read-only), K confirms; required and recommended specifics filled only from confirmed facts, the rest asked or left out.
5. **The draft.** Title (80 characters, the words buyers search), description in K's voice (condition first, what's included, measurements, collection offered for big items), specifics, eBay condition. K can edit every field.
6. **Price.** The pricing engine on the draft (photos and facts): recommended price with its evidence, the same as a price check. Nothing comparable: "Set the price yourself" (own price, watched weekly). Floor price optional; Best Offer on by default.
7. **Postage.** Live carrier rates for the size and weight (see the decisions), the cheapest suitable service suggested and rounded up, as K prefers. Collection in person always offered on large items; "collection only" a switch.
8. **Check and submit.** eBay checks the listing (`VerifyAddFixedPriceItem`): errors explained in plain words, fees shown. It then becomes a `create_listing` label in the Inbox.
9. **Publish, on approval only.** Through the write gate: photos uploaded to eBay's picture service as file bytes (`UploadSiteHostedPictures`, never a public link to our storage), then `AddFixedPriceItem`, then the audit log. The new listing appears in Listings, with the engine's weekly watch if it's on an own price.

**Drafts** are saved at every step and resumable ("Drafts" on Listings). An abandoned draft's photos are deleted after 30 days.

## Safety

- No new way to change eBay: publishing is a `create_listing` proposal through `ebayWrite()`, and `UploadSiteHostedPictures` is added to the write gate's calls (called only while applying an approved listing). Source scans and the allowlist test cover both.
- Photos never become public: Claude gets them as image data, eBay as uploaded bytes.
- Price labels follow the engine rule already enforced in code (one of its prices, or K's own).
- Only facts with a source go into the listing. A test checks that the draft's specifics come only from facts marked "photo", "from you" or a cited page.

## Testing

Everything runs end to end on **Sandbox** first (writes are on there): photos, draft, eBay's check, approve, publish, the listing visible on Sandbox eBay. On production, drafting works while read-only. eBay's check needs the full-permission sign-in, so the first real listing is part of go-live (section I).

## Cost per listing

About 10 to 20p in Claude (photo review, identification, specs, draft) and 2 to 4 sold-data searches (within the monthly caps: Trawl 250, CompsAPI 100). Nothing is spent until K asks for the photo review.

## Build order

| Step | What | Done when |
| --- | --- | --- |
| L1 | Drafts and photo storage: upload (resize, strip location), on-phone checks, list and resume drafts | Photos stored privately, a draft survives closing the app |
| L2 | Photo review and identification (images sent as data), the facts form, sources on every fact | A draft lists its facts with sources and asks only what K knows |
| L3 | Category suggestions, specifics from confirmed facts, title and description in K's voice | A complete draft K can edit |
| L4 | Price (engine or own price), live postage rates, collection, background tidy-up (ordinary edits only) | Price and postage set with their reasons |
| L5 | eBay's check, the `create_listing` label, publishing through the gate with picture upload | A listing published on Sandbox from an approved label |
| L6 | Tests (scans, sources-only facts, gate refusals), docs, Sandbox walk-through with K | K publishes a test listing on Sandbox from the phone |

The screens are built in the current design. K's UI update, which is coming, then restyles them with the rest.

## K's decisions (2026-11-05)

1. **Who lists:** any of the three people can draft and approve a new listing, as with other labels.
2. **Postage: live carrier rates.** The draft shows real prices for the parcel's size and weight, and suggests the cheapest suitable service, rounded up (K prefers charging a little more and refunding). Open: the data source (below).
3. **Photo cleanup:** a listing's photos are deleted from our storage 30 days after it's published; an abandoned draft's photos after 30 days too. eBay keeps its own copies.
4. **Background tidy-up: yes, ordinary photo edits only.** Nothing AI-generated, and nothing a buyer could call a fake photo of the item:
   - Allowed (what anyone could do in a basic editor): crop and straighten, exposure, contrast and white balance on the whole photo, and brightening the plain background to white with an edge-based "magic wand" selection that stops at the item's outline.
   - Never: generative fill, AI background replacement, removing or adding objects, retouching marks, scratches or wear, or changing the item's colour or shape. Flaws must stay visible (eBay requires photos to show the actual item).
   - Done with plain image operations (no image-generation model), the original kept, a before-and-after shown, and K chooses per photo. Off for a photo where the selection would touch the item.

## Photo tools and drafts (K, 2026-11-07)

- **Adjust (rotate, crop, centre)** on each photo: Rotate left and Rotate right (quarter turns), then drag to move, pinch, scroll or slider to zoom, a thirds grid with a centre cross, and the shapes Square, 4:3 or Original (`web/src/listing/adjust.tsx`, maths in `frame.ts`).
  - **Centre on item:** puts the item's estimated centre in the middle, zoomed so the item fills about two thirds of the frame. It never cuts the item off, and never goes under eBay's 500 px minimum.
  - **It's an ordinary crop:** nothing is added or painted. It saves an edited copy (the original is kept, with Use original to switch back), and the photo checks run again on it, so a fixed "off-centre" warning disappears.
  - **Tidy background and Adjust stack:** each works on the version in use, and both edits are recorded.
- **Arrange photos:** every photo as a small tile, dragged into order (or moved with the arrow keys). The first is the main photo; Done saves the order (`arrange.tsx`).
- **Drafts:** save as you go ("Save and close" at the top). In the drafts list, each open draft has **Rename** and **Delete**.
  - **Rename:** sets a name for the list only (`name`). It never changes "What is it, in your words?", which Claude reads, or the listing title.
  - **Delete:** asks first, then deletes the draft and its photos.

## Postage rate source (K, 2026-11-05)

The **Parcel2Go Quoting API**, matching eBay's Simple Delivery carriers:

1. Send the listing's parcel size and weight to Parcel2Go's quote endpoint.
2. Keep only the carriers eBay uses for Simple Delivery: **Evri, Royal Mail, DHL and InPost**.
3. Sort by price and show the cheapest as the postage estimate, with the carrier and service named.

Needs K's Parcel2Go API credentials (secrets in Key Vault, never in code) and Parcel2Go's host added to the reviewed network list (the safety scans). Details are checked against Parcel2Go's API documentation at step L4, and K is asked for the credentials then. Not considered: scraping any website (against the project rules).

## L1 as built

- Server: `src/drafts.ts` (routes under `/api/drafts`), `src/store/drafts.ts`, `src/photos.ts` (JPEG checks, metadata stripped again on the server), `src/platform/azure/photos.ts` (the private `photos` container, through the app's identity; no infrastructure change). The nightly abandons drafts untouched for 30 days and deletes their photos.
- Phone: `web/src/listing/` (the Sell screen, the checklist, camera or file picker, resize to 2400 px and re-encode, which drops the location; instant checks for size, light, blur and repeated shots, with retake advice and "Keep anyway"). Photos are served only to a signed-in person.
- Tests: `test/drafts.test.ts`, `test/listing-checks.test.ts`. The blur limit is a starting value, tuned in the Sandbox walk-through.
