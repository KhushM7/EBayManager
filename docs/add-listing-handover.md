# Add Listing: handover (updated 2026-11-06)

What was built for Add Listing, how it was merged with the redesigned frontend, what is checked automatically, what K still needs to test by hand, and every step left before going live. Plan and decisions: [add-listing.md](add-listing.md).

## Where everything is

| Branch | What's on it | State |
| --- | --- | --- |
| `main` | Phase 7 (first-day audit), merged from PR #10 | Behind: none of the Azure work yet |
| `azure-migration` | The move to Azure (M0–M7), Inbox to-dos, pricing revision 3, the identification fix, go-live progress, the Add Listing plan | Production runs this branch's code (whatever K last deployed) |
| `add-listing` | Add Listing L1 to L5 (server, and a plain `/sell` screen), on top of `azure-migration` | Merged into `merge-redesign` |
| `claude/frontend-redesign` | The redesigned dashboard and its New listing wizard on sample data | Merged into `merge-redesign` |
| **`merge-redesign`** | **Both, with the redesign's wizard running on the real drafts server** | Tests pass. Deployed to Sandbox on 2026-11-06; checks pass. To be merged into `azure-migration` |

## How the two branches were merged (2026-11-06)

K chose the redesign's wizard (2026-11-06). The merge kept the `add-listing` server untouched and gave it the redesign's screen:

1. `merge-redesign` starts from `add-listing` (which already holds all of `azure-migration`) and merges `claude/frontend-redesign`. Only three files conflicted: `package.json` (both sets of dependencies kept: Azure Blob storage, Tailwind, Framer Motion, Inter; the old Rokkitt and Literata fonts dropped), `package-lock.json` (rebuilt by `npm install`), and `web/src/main.tsx` (the redesign's shell; `/sell` now opens the wizard at `/new`).
2. **One Sell screen.** `web/src/wizard.tsx` keeps the redesign's look (steps, camera overlay, glow, toasts) and runs every step of the old `Sell.tsx` on `/api/drafts`: drafts and "Sent and listed", what it is in your words, photos with Retake / Keep anyway / Discard, reorder, remove, background tidy-up, Claude's photo check, facts, category, listing text and specifics, the engine's three prices or your own, floor, offers, postage, eBay's check and send, "Edit it again", delete. The draft lives in the address (`/new?draft=…`), so reload and back work. `Sell.tsx`, `listing.css` and the three placeholder `/listing-assistant/*` routes are gone.
3. **One set of photo checks**: the redesign's `photocheck.ts` (light, glare, even light, focus, contrast, framing, clutter, size, shape) plus the same-shot check from `add-listing`. It runs on the resized, location-free copy that is uploaded, and is tested on synthetic images (`test/listing-checks.test.ts`). Only serious findings (dark, blurry, too small, the same shot twice) hold a photo before upload; the rest are advice.
4. **Sample data runs the real server.** Under `MOCK=1`, `/api/drafts` is answered by the real `src/drafts.ts`, `src/newlisting.ts`, pricing engine, proposals and write gate, in memory, with stand-ins only for Claude, eBay, Trawl and Parcel2Go (`web/mock-drafts.ts`). Labels it files show in the sample Inbox and can be approved there through the real gate.
5. **Nothing lost**: every file either branch changed was compared with the merge. The server and its tests (`src/`, and `test/` apart from the photo-check tests) are byte-for-byte `add-listing`'s; every redesign file is the redesign's, except `main.tsx` (one route alias), `mock.ts` (the drafts routes), `photocheck.ts` (made testable, same-shot check added) and `wizard.tsx` (rewired).

## What was built

Every step is tested with stand-ins for Claude, eBay and Azure storage (the full suite: 273 tests pass, 1 skipped; typecheck, the web build, the Azure package build and `npm audit --omit=dev` are clean).

### L1. Drafts and photos

- **Sell screen**: since the merge, the redesign's wizard (`web/src/wizard.tsx`, route `/new`; `/sell` still works): new listing, drafts list, "Sent and listed", the photo checklist, Take a photo (camera) or Upload.
- **On the phone** (`web/src/listing/photos.ts`, `web/src/photocheck.ts`, `web/src/listing/checks.ts`): each photo turned upright, resized to at most 2400 px and re-encoded (which drops its location), then graded at once (light, glare, focus, framing, background, size, and the same shot twice, also against photos uploaded earlier). A photo with a serious problem offers Retake, Keep anyway or Discard.
- **On the server** (`src/photos.ts`, `src/drafts.ts`, `src/store/drafts.ts`, `src/platform/azure/photos.ts`): checks each upload is a real JPEG of sensible size, strips metadata again, stores it in the private `photos` Blob container through the app's own identity. No infrastructure change was needed for photos. Photos are served only to a signed-in person. Order, remove, up to eBay's 24.
- **Cleanup** (nightly): drafts untouched for 30 days are abandoned and their photos deleted; a deleted draft's photos go at once.

### L2. Photo check and facts

- **Claude's photo check** (`src/newlisting.ts`, `reviewDraft`; Sonnet; about 3 to 6p): sees the photos as image data (never a public address) and returns what the item is, whether the exact model is certain, the shots that are missing and why, notes on particular photos, what the photos show (each fact with its photo number), every visible flaw, and questions only K can answer.
- **eBay's category suggestions** (Taxonomy, read-only) and that category's item specifics with eBay's allowed values.
- **Published specs**, only for an exactly identified product, each kept only with a source page (the existing `src/specs.ts`).
- **Facts form**: condition (always K's, required), does it work, marks, what's included, what's missing, answers to Claude's questions, anything else.

### L3. The listing text

- **Claude writes** the title (80 characters), description (condition first, flaws plainly, collection mentioned when offered, K's tone, no greeting or promises) and item specifics (`composeDraft`; Sonnet; about 2 to 5p).
- **Sources enforced in code** (`sourcedSpecifics`): each specific names its source (a photo number, "you", or a published-spec page) and is kept only if every value is found in that source; selection-only specifics must use eBay's values. What's dropped is shown with the reason.
- **K edits** the title and description, removes specifics, or adds one from K (selection-only values from eBay's list).

### L4. Price, postage, background tidy-up

- **Price** (`priceDraft`, `choosePrice`): the pricing engine on the draft. K picks one of its three prices; an own price is allowed only when nothing comparable has sold, the same rule as live listings. Floor optional; Best Offer on by default.
- **Postage** (`savePostage`): K's figure (rounding up is fine), collection also welcome, collection only, the postcode it's sent from (remembered).
- **Parcel2Go** (`src/postage.ts`): sign-in and the quote request exactly as Parcel2Go's docs describe, with the parcel's size, weight and value (never an address). The filter to eBay's Simple Delivery carriers (Evri, Royal Mail, DHL, InPost), cheapest first, is built and tested. **Reading their quotes is switched off** (`QUOTE_FORMAT_CONFIRMED = false`): their docs don't say what each quote's fields are. Until it's confirmed, the screen says so and K types the postage.
- **Background tidy-up** (`web/src/listing/tidy.ts`, on the phone): white balance and exposure for the whole photo alike, the plain background turned white with an edge-in selection that stops at the item, and a crop to the item. It refuses when the background isn't plain and light, when the item is too close in colour to the background, or when the selection would reach the middle of the photo. Before-and-after shown; K chooses per photo; the original is kept and can be switched back.

### L5. Send for approval and publish

- **Submit** (`submitDraft`): lists anything still missing; eBay's check (`VerifyAddFixedPriceItem`) with fees shown and errors explained; then a `create_listing` label in the Inbox. eBay's check runs before photos are uploaded, so a complaint only about photos is noted, not a failure.
- **Publish, on approval only** (`src/ebay/write.ts`): the write gate claims the label, uploads each photo to eBay's picture service as bytes (`UploadSiteHostedPictures`, each upload in the audit log), then lists the item with eBay's picture addresses and "collection in person" as a free second service when offered. The draft becomes "Listed, item …". While changes are off, the label is a dry run: approving records it and nothing reaches eBay; the draft can then be edited again.
- **Reopen**: a submitted draft whose label was rejected, expired, or recorded as a dry run goes back to editing.
- **Safety**: `UploadSiteHostedPictures` added to the allowlist's write calls (only the gate sends it); a new upload function in the Trading client is limited to the gate like the existing one (test); Parcel2Go added to the reviewed network modules (test); `security.md` updated.

## What is checked without K

| Check | How | Result |
| --- | --- | --- |
| Typecheck, 276 tests, both builds, `npm audit` | `npm run typecheck && npm test`, `build:web`, `build:azure` | Pass (2026-11-06) |
| Every step of the wizard against the real server code | `MOCK=1`, driven in headless Chrome at phone (390 px) and desktop (1440 px) widths: photos (a good shot uploads at once; a dark, blurry one and a repeat are held), Claude's check, facts, listing, price, postage, send, the label in the Inbox, approve (item listed), reject then "Edit it again", the tidy-up and switching back | Pass. Two bugs found and fixed: quick successive edits on the postage and facts forms could undo each other, and the "what is it" box had been left out |
| Every other screen still loads | The same, on Inbox, Listings, Insights, Store Pulse, Activity, Settings, and the old `/audit` and `/sell` links | Pass |
| **The real services on Sandbox** | `node scripts/sandbox-listing-check.mjs` after deploying: photo upload to Azure Blob storage and back without metadata, Claude's real photo check and listing text, eBay's real category suggestions and specifics, the pricing engine with real sold data, eBay's real `VerifyAddFixedPriceItem`, the label in the Inbox. With `--approve`: `UploadSiteHostedPictures` and `AddFixedPriceItem` on eBay Sandbox, and the audit log | **Pass, 2026-11-06** (without `--approve`): Blob storage, Claude (named the item exactly from the label photo), Taxonomy (Headphones, 16 specifics), the engine (£86.49 from real sold data), `VerifyAddFixedPriceItem`, the label. It found one problem, now fixed: Claude padded titles to 80 characters ("…Over-Ear Used Headphones On"); the prompt now says shorter is fine. The deployed screens load at phone width with no console or security-policy errors |

Still only met stand-ins after all that, so they're what K's test is for:

1. **The phone's camera** and real photos: the resize, the checks' thresholds (the blur limits `BLUR_BAD` and `BLUR_SOFT` in `photocheck.ts` are starting guesses), and the tidy-up on a real background.
2. **Whether Claude's words are right** about a real item: the name, the shots it asks for, the questions, the title and description.
3. **eBay condition IDs** (new 1000, used 3000, for parts 7000): some categories use others; eBay's check says so.
4. **The postage service code** sent to eBay is Royal Mail 2nd Class whatever carrier is picked (see "Left to build").
5. On production, eBay's check needs the full-permission sign-in (go-live section I), so a real draft can only be submitted on production after going live.

## eBay Sandbox's picture service is down (2026-11-06)

K's first Sandbox approval failed at the first photo: `UploadSiteHostedPictures` answered "Internal error to the application" (error 10007). eBay's API status page lists the Sandbox picture service as not working (unresolved since 2025), and developers report the same call working on production. So on **Sandbox only**, a first photo failing that way now lists the item without photos and says so in the result; the rest of publishing (specifics, postage, collection, the audit log) can be checked. On production a failed photo always stops the listing (both tested). The photo upload itself is first truly tested with the first real listing after going live (go-live I5), which K checks on eBay anyway. A failed label shows under the Inbox's **Refused** tab, and its draft can be reopened with "Edit it again".

## From K's first real item (an air fryer, 2026-11-06)

| K found | Cause | Fixed |
| --- | --- | --- |
| The photo check suggested removing film and powering on an opened, unused item | It looked at the photos before knowing the condition | The condition is chosen first (new, **opened, never used** (eBay 1500), used, for parts) and given to Claude, which never suggests unpacking, plugging in or testing a new or unused item |
| Title cut mid-word ("…Black Opened Ne") | Clipped by code at 80 characters | Claude is told to count; a long title is cut at a whole word (`fitTitle`) |
| Description lacked the product's published details | The research's web search ran out of uses (4, and with dynamic filtering every lookup counts) | 10 searches plus opening pages (the manual), features recorded as well as sizes, and the names it's sold under. It found the **SHFD 1400 C1** behind Lidl's 438124, with 15 sourced specs |
| "No sales found", though many are listed | Searched with Lidl's item number, which sellers don't use; then a used sale was taken for an exact match, adjusted the wrong way | Other names and broader searches when the first finds under 5 sales; each sale's condition shown to the matcher; the adjustment direction spelled out. Priced at £21.99 from two new sales (£28.12, £37.73) and one used (£12.79 adjusted up) |

## Postage, done for K (2026-11-06)

K's choice (b): the app creates the listing, then K switches its postage to Simple Delivery in Seller Hub, because eBay's API can't set Simple Delivery (eBay developer support). Arriving at Postage, the app:

1. Works out the packed parcel (`planPostage`, Sonnet, about 1 to 2p) from the researched specs, the photos and K's facts: the item, its original box if any, accessories, a shipping box and padding, rounded up. Each figure says whether it came from the manufacturer or is estimated; when it can't tell, it asks K to measure.
2. Picks the size from eBay's own list (K's screenshot: Large letter up to 1 kg; Small parcel 1 or 2 kg; Medium parcel 1, 2, 10 or 20 kg): the smallest the parcel fits on every side, with the weight 5% under the band. K can change it from a dropdown.
3. Bigger than a medium parcel, over 20 kg, or priced over £750 (Simple Delivery's limit): a courier, quoted across every courier by Parcel2Go.
4. Fills in the postage from the cheapest quote (rounded up to 50p) with the remembered postcode.
5. After the listing goes live, files an Inbox to-do with the steps: Seller Hub, Edit, Buyer pays postage, the size; use eBay's recommendation if it differs.

Checked on the air fryer: 44 x 37 x 38 cm, 4.8 kg, Medium parcel up to 10 kg, which is what eBay recommended to K.

## What K needs to test by hand

Two short sessions; everything else is scripted above or already recorded in [go-live-tests.md](go-live-tests.md).

**1. Sandbox, on the phone (about 15 minutes):**

1. Open the Sandbox app, tap **+** (New listing), and photograph something real: one good shot, one dark or blurry one (it should be held with clear advice), and the same shot twice.
2. Tidy the background on one photo taken on a plain light surface: the item should look unchanged.
3. Go through the steps. Judge only the words: is the item named right, are the questions things only you know, is the title good and the description true?
4. Send it, approve the label in the Inbox by swiping, and open the item on Sandbox eBay: photos, postage, collection and specifics as you set them.
5. While there, swipe through the redesigned screens once (Inbox, Listings, Insights, Settings).

Tell Claude anything that reads badly and any photo wrongly flagged or missed, so the thresholds can be tuned.

**2. Production, before going live:** the remaining (K) go-live items: B10, B13 and B14 (the new sign-in and hidden site), C1, C3 and D5 (spot-check 5 listings against Seller Hub), E2 and E3 (to-dos, style guide), F1 to F4 (labels, evidence, facts, floors), G2 and G3 (message drafts and offers), H1, H2 and H4 (push, a dry-run notification, pause and resume). H3 (every screen on phone and computer) is covered by the screen runs above on the same build, so on production it's only a look.

## Left to build

| Item | Needs | Notes |
| --- | --- | --- |
| ~~Reading Parcel2Go quotes~~ | Done 2026-11-06 | K's credentials are **live** ones (the sandbox API refuses them; quoting on live is free and books nothing). `scripts/parcel2go-quote.mjs --live`: 34 to 41 quotes a parcel in about 3 s; cheapest Simple Delivery carriers for a 1 kg box: InPost £2.64, Evri £2.71, Royal Mail 48 Tracked £3.75. `readQuote` is tested on that real reply and switched on. Verdict: keep Parcel2Go; no simpler API needed. Prices are what K pays booking through Parcel2Go, a guide to what to charge. To reach the apps (K: Claude was not permitted): `node scripts/azure-infra.mjs sandbox` (adds the two settings; checked 2026-11-06 that they are missing), then `node scripts/azure-secrets.mjs sandbox`; for production the same two with `EBAY_CONFIRM_PRODUCTION=yes`, after adding the credentials to `.prod.vars` |
| **eBay service code from the chosen carrier** | Nothing from K | Map the chosen carrier (Evri, Royal Mail, DHL, InPost) to eBay's UK shipping service codes, instead of always Royal Mail 2nd Class. Check the codes against eBay (`GeteBayDetails` is a read call) on Sandbox |
| **"Your best past photos" reference** | Nothing | The plan's checklist mentions a thumbnail of K's best past photos as the background reference; not built |
| **Straighten** | Nothing | Allowed in the tidy-up list, not implemented (crop, exposure, white balance and background are) |

## Steps left before going live (updated end of 2026-11-06)

**(K)** is K, **(C)** is Claude. Done so far: the merge (`merge-redesign`), Sandbox deploys and checks, Parcel2Go (live credentials, quotes switched on, Sandbox settings and secrets uploaded), and every fix from K's first real item (condition first, titles, research, the seller's pricing rule, postage done for K).

**A. Code to `main`**
1. **(K)** Push `merge-redesign`, fast-forward `azure-migration` to it, push, then open and merge the pull request `azure-migration` → `main` (commands in the session notes; nothing in them deploys).
2. **(C)** Small items before production, none needing K: the eBay shipping service sent for courier-sized parcels (now always Royal Mail 2nd Class, the placeholder until K switches to Simple Delivery); and re-run go-live A1 (typecheck, tests) on the merged `main` commit.

**B. Production update (read-only still)**
Sign-in changed on 2026-11-07 ([security.md](security.md)): email and authenticator code, people set by `scripts/people.mjs`, and a hidden site. Passkeys stop working on the first deploy of this code, so do steps 3 and 3a together.
3. **(K)** Put the Parcel2Go credentials in `.prod.vars` (`PARCEL2GO_CLIENT_ID`, `PARCEL2GO_CLIENT_SECRET`; no `PARCEL2GO_SANDBOX`: they're live credentials). Then:
   `$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-infra.mjs production`
   `$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-secrets.mjs production`
   The infrastructure run also adds the two new settings, `PEOPLE` and `SIGNIN_PATH`.
3a. **(K)** Set yourself up: `$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/people.mjs production add --email <your email> --name K --role owner`. Scan the QR code into your authenticator app and bookmark the sign-in address it prints. (Same on Sandbox first, without the variable, to try it.)
4. **(K)** Deploy `main` to production: `$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-deploy.mjs production`, then `node scripts/check-production.mjs`.
5. **(K)** Settings → Sold data: re-run the comparison. With the identification fix and the seller's rule, the engine should be at or better than the 12.4% off it scored before. Tell Claude the figure.

**C. Go-live tests on production** ([go-live-tests.md](go-live-tests.md); manager items N/A until a manager joins). Let one nightly run (02:00) and a day of the 15-minute poll happen on the new code first.
6. **(C)** C2 (stored scopes read-only), C4 (orders match), C5 (policies), C7 (eBay call volume), D1 to D4 (nothing can change the real account), E1 (audit covers everything), G1 (the poll ran clean), A1 on the deployed commit.
7. **(K)** One session on the phone and computer: B10 (sign in on phone and computer), B13 (a new authenticator code), B14 (the site is blank from outside), C1 (Settings shows production, read-only), C3 and D5 (spot-check 5 listings against Seller Hub, none revised), E2 and E3 (to-dos, style guide), F1 to F4 (10 dry-run labels make sense with evidence, no invented facts, floors set), G2 and G3 (message drafts and offer suggestions; a test question from another account if none arrived), H1 to H4 (push pop-up, a dry-run notification, every screen, pause and resume). Also one New listing on production up to "Send for approval": eBay's check there needs the full-permission sign-in, so on production it stops at that step until go-live.

**D. Go live (section I)**
8. **(K)** Sign in to eBay again through the production app, granting full permissions (I1).
9. **(C)** Prepare the change: `writeMode = 'approval'` in `infra/production.bicepparam` and the template's production override removed in `infra/main.bicep`. **(K)** reviews it, then runs the production infrastructure and deploy commands (I2).
10. **(K)** First changes, one at a time, each checked on eBay: a small reversible one (a typo in a title), then the first 10 (I3, I4); one price change and one offer answer end to end (I5).
11. **(K)** First real listing through New listing: approve it, check it on eBay (photos, specifics, collection), then do its Inbox to-do: switch postage to Simple Delivery at the app's size in Seller Hub, and note whether eBay recommended the same size.

**E. After**
12. ~~M8, delete Cloudflare~~: done 2026-11-07 (K asked early): Workers, D1 databases and the empty R2 buckets deleted, the `.d1-production.sql` export removed, `wrangler`, `wrangler.toml`, `schema.sql` and the D1 import code gone.

## Decisions for K

1. ~~Sell screen~~: the redesign's wizard (2026-11-06).
2. ~~Sandbox deploys~~: allowed once both branches were read and nothing lost (2026-11-06).
3. ~~Parcel2Go~~: kept (live credentials; quotes checked 2026-11-06). Simple Delivery via Seller Hub after publishing, option (b) (2026-11-06).
