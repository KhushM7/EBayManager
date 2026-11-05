# Add Listing: plan

K's request (2026-11-05): build and finish **Add Listing** before going live. Status: **plan, waiting for K's decisions** (end of this doc). Design principles stay those of [listing-assistant.md](listing-assistant.md): coach the photos, never assume a fact, price from the market, and nothing is listed until K approves.

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
7. **Postage.** A suggestion from size and weight (see decision 2), rounded up, as K prefers. Collection in person always offered on large items; "collection only" a switch.
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
| L4 | Price (engine or own price), postage suggestion, collection | Price and postage set with their reasons |
| L5 | eBay's check, the `create_listing` label, publishing through the gate with picture upload | A listing published on Sandbox from an approved label |
| L6 | Tests (scans, sources-only facts, gate refusals), docs, Sandbox walk-through with K | K publishes a test listing on Sandbox from the phone |

The screens are built in the current design. K's UI update, which is coming, then restyles them with the rest.

## Decisions for K

1. **Who can create listings?** Recommended: anyone can draft, only K approves the `create_listing` label (today any of the three can approve any label).
2. **Postage suggestion.** Recommended: K's own price table by size band (for example small parcel, medium parcel, large or heavy), set once in Settings and rounded up, instead of live carrier rates. It matches K's choice to charge a little more and refund.
3. **Photo cleanup.** Recommended: delete a listing's photos from our storage 30 days after it's published (eBay keeps its own copies).
4. **Background tidy-up** (cropping and whitening the background automatically). Recommended: not now. The coaching aims for good photos instead; it can be added later.
