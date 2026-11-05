# Add Listing: handover (2026-11-05)

What was built on the `add-listing` branch, what K needs to test, what's left to build, and every step left before going live, including merging with the redesigned frontend. Nothing here has been deployed. Plan and decisions: [add-listing.md](add-listing.md).

## Where everything is

| Branch | What's on it | State |
| --- | --- | --- |
| `main` | Phase 7 (first-day audit), merged from PR #10 | Behind: none of the Azure work yet |
| `azure-migration` | The move to Azure (M0–M7), Inbox to-dos, pricing revision 3, the identification fix, go-live progress, the Add Listing plan | 32 commits ahead of `main`. Production runs this branch's code (whatever K last deployed) |
| `add-listing` | Add Listing L1 to L5, server and phone, on top of `azure-migration` | Pushed. Tests pass. Not deployed anywhere |
| `claude/frontend-redesign` | The redesigned dashboard (glass and glow, swipeable approvals, Store Pulse, Insights) and its own **New listing wizard** at `/new`, which calls three `/listing-assistant/*` endpoints that were never built | Pushed. Has its own merge guide: [frontend-redesign-merge.md](https://github.com/KhushM7/EBayManager/blob/claude/frontend-redesign/docs/frontend-redesign-merge.md) |

The two branches build the same feature from different ends: `add-listing` has the real server (drafts, private photos, Claude, eBay, the write gate) and a plain screen at `/sell`; the redesign has the new look and a wizard on sample data. The plan below keeps the `add-listing` server and gives it one screen in the new look.

## What was built

Every step is tested with stand-ins for Claude, eBay and Azure storage (the full suite: 273 tests pass, 1 skipped; typecheck, the web build, the Azure package build and `npm audit --omit=dev` are clean).

### L1. Drafts and photos

- **Sell screen** (`web/src/listing/Sell.tsx`, route `/sell`): new listing, drafts list, "Sent and listed" list, the photo checklist, Take photos (camera) or Choose photos (files).
- **On the phone** (`web/src/listing/photos.ts`, `checks.ts`): each photo turned upright, resized to at most 2400 px and re-encoded (which drops its location), then checked instantly for small, dark, too bright, blurry, and the same shot twice (also against photos uploaded earlier). A flagged photo offers Retake, Keep anyway or Discard.
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

## Not yet verified (honest list)

Everything below is built but has only met stand-ins:

1. **Real photos on a real phone**: the camera, the resize and re-encode, the instant checks. The blur limit is a starting guess, to tune on K's photos ("Keep anyway" means a wrong flag never blocks a photo).
2. **Real Claude calls** for the photo check and the listing text (prompts and output formats are tested against a stand-in, not the model).
3. **Real eBay calls**: Taxonomy category suggestions and aspects (response fields as I know them from eBay's API), `VerifyAddFixedPriceItem` from a draft, and above all **`UploadSiteHostedPictures`**: its multipart format is written from eBay's documented pattern and has never been sent. First real test: Sandbox.
4. **Azure Blob storage**: the photo store code is written against the Azure SDK but has never run in Azure.
5. **Background tidy-up on real photos** (tested on synthetic images only).
6. **eBay condition IDs**: new 1000, used 3000, for parts 7000. Some categories use others; eBay's check will say so if a category doesn't accept them.
7. **The postage service code** sent to eBay is Royal Mail 2nd Class for every listing (as before), whatever carrier K picks; only the price follows K's choice. See "Left to build".
8. **On production, eBay's check needs the full-permission sign-in** (go-live section I), so a real draft can only be submitted on production after going live. Sandbox has full permissions.

## What K needs to test

Once Claude may deploy to Sandbox (K's permission is needed because the redesign may be deploying there too), a walk-through on the phone, on Sandbox:

1. **Photos**: Sell → New listing → Take photos of something real. Check that a dark or blurry shot is flagged with sensible advice, that a good one uploads straight away, that the main photo can be reordered and a photo removed. Then Choose photos from the gallery, and try the same shot twice.
2. **Tidy-up**: on a photo taken on a plain light background, Tidy background → check the before-and-after looks like an ordinary edit, the item unchanged (marks still visible) → Use tidied → switch back to the original. Try it on a cluttered background: it should refuse.
3. **Photo check**: Check the photos → is the item named correctly? Are the "shots to add" sensible? Are the questions only things you alone know?
4. **Facts**: fill them in and save.
5. **Category and listing**: is eBay's suggested category right? Write the listing → is the title good and the description true? Any specific left out that you'd expect (see "left out because no source showed them")? Edit the title, remove and add a specific.
6. **Price**: Price it → does the engine's reasoning make sense? Pick a price; if it says nothing has sold, set your own.
7. **Postage**: enter the parcel's size and weight → Get prices (expect the "not set up yet" message until Parcel2Go is connected) → type postage, tick collection welcome, enter the postcode, save.
8. **Send**: Check with eBay and send for approval → is the label in the Inbox with the right price, postage and fees? Approve it on Sandbox → the item should appear on Sandbox eBay with its photos, the collection option and the specifics. Check the photos on eBay have no location (eBay strips it too, but ours never sent it).
9. **Reject path**: send a second draft, reject the label, then "Edit it again" and resend.

Tell Claude anything that reads badly, any wrong flag, and the blur cases, so the thresholds can be tuned.

## Left to build

| Item | Needs | Notes |
| --- | --- | --- |
| **Reading Parcel2Go quotes** | K's Parcel2Go **sandbox** API credentials (Parcel2Go → My account → API), then live ones | Claude checks a real sandbox reply, writes `readQuote`, sets `QUOTE_FORMAT_CONFIRMED = true`, tests it. Credentials go in `.dev.vars` / `.prod.vars` as `PARCEL2GO_CLIENT_ID`, `PARCEL2GO_CLIENT_SECRET` (and `PARCEL2GO_SANDBOX=true` for the sandbox), uploaded with `scripts/azure-secrets.mjs`. The Key Vault references are already in Bicep, so each environment's infrastructure must be redeployed once (`scripts/azure-infra.mjs`) to add the app settings |
| **eBay service code from the chosen carrier** | Nothing from K | Map the chosen carrier (Evri, Royal Mail, DHL, InPost) to eBay's UK shipping service codes, instead of always Royal Mail 2nd Class. Check the codes against eBay (`GeteBayDetails` is a read call) on Sandbox |
| **One Sell screen in the new look** | K's choice (below) | Either port the wizard's visuals (`wizard.tsx`, `camera.tsx`) onto the drafts API, or restyle `Sell.tsx` with the new design system. Then delete the other flow and its mock endpoints |
| **One set of photo checks** | As above | `web/src/listing/checks.ts` (brightness, blur, size, repeats) and the redesign's `photocheck.ts` (adds glare, even light, contrast, framing, clutter). Keep one, likely the redesign's measures with the upload-time duplicate check |
| **Sample data for the Sell screen** | Nothing | `web/mock.ts` has no `/drafts` routes, so `MOCK=1` shows an error on Sell. Left alone to avoid clashing with the redesign; add after the merge |
| **"Your best past photos" reference** | Nothing | The plan's checklist mentions a thumbnail of K's best past photos as the background reference; not built |
| **Straighten** | Nothing | Allowed in the tidy-up list, not implemented (crop, exposure, white balance and background are) |

## Steps left before going live

In order. **(K)** is K, **(C)** is Claude.

1. **(K)** If not done since the fix on 2026-11-05: deploy `azure-migration` to production (the identification fix `ede0bc4`) and re-run Settings → Sold data. The engine column should say "matched by Claude" and be back near 12.4% off. Tell Claude the result.
2. **(K)** Decide the Sell screen: (a) the redesign's wizard, rewired by Claude to the drafts API, or (b) `Sell.tsx` restyled in the new look. Recommendation: (a), since the wizard's camera and photo grading are richer and the server is the part that matters.
3. **(C)** Merge, as the redesign's guide suggests, on a new branch so nothing is lost:
   1. `add-listing` into `azure-migration` (the backend, with tests).
   2. `claude/frontend-redesign` into `azure-migration`. Expect conflicts in `web/src/main.tsx` (take the redesign's shell, add the one Sell route), `package.json` and `package-lock.json` (take the redesign's, then `npm install`).
   3. Apply K's choice from step 2: wire the chosen screen to `/api/drafts`, map or replace `listing.css`'s old tokens (`--paper`, `--ground`, `--ink`), keep one set of photo checks, delete the unused flow, the three `/listing-assistant/*` mock routes and the "Wizard API contract" section of `listing-assistant.md`, and add `/drafts` sample data to `web/mock.ts`.
   4. Typecheck, tests and both builds; check every screen on `MOCK=1` at phone and desktop widths.
4. **(K)** Allow Claude to deploy the merged branch to Sandbox. **(C)** deploys and runs `node scripts/check-production.mjs sandbox`.
5. **(K)** The Sandbox walk-through above, plus a look round the redesigned screens. **(C)** fixes what's found, tunes the blur limit, verifies the picture upload and Taxonomy fields against Sandbox, and records the results.
6. **(K)** Parcel2Go sandbox credentials → **(C)** finishes quote reading, then the eBay service code mapping. Live credentials later.
7. **(K)** Open a pull request from `azure-migration` to `main` and merge it, so `main` is what runs: https://github.com/KhushM7/EBayManager/compare/main...azure-migration
8. **(K)** Infrastructure update for the new Parcel2Go settings: `$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-infra.mjs production` (Claude does Sandbox), then `scripts/azure-secrets.mjs production` once `.prod.vars` has the credentials.
9. **(K)** Deploy `main` to production (`$env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/azure-deploy.mjs production`), then `node scripts/check-production.mjs`. **(C)** re-runs go-live A1 on that exact commit.
10. **Remaining go-live tests** ([go-live-tests.md](go-live-tests.md); manager items are N/A until a manager joins):
    - **(C)**: C2 (stored scopes read-only), C4 (orders match), C5 (policies), C7 (eBay call volume), D1 to D4 (nothing can change the real account), E1 (audit covers everything), G1 (the 15-minute poll ran clean).
    - **(K)**: B13 (test a recovery code, register a new passkey), C1 (Settings shows production, read-only), C3 and D5 (spot-check 5 listings against Seller Hub, none revised), E2 and E3 (the to-dos and the style guide), F1 to F4 (10 dry-run labels, market evidence, no invented facts, floors), G2 and G3 (message drafts and offer suggestions; a test question from another account if none arrived), H1 to H4 (push on the phone, a dry-run notification, every screen on phone and computer, pause and resume).
11. **Go live (section I)**:
    1. **(K)** Sign in to eBay again through the production app, granting full permissions.
    2. **(K)** Set `writeMode = 'approval'` in `infra/production.bicepparam` and remove the template's production override in `infra/main.bicep` (Claude prepares this change for K to review), then run the production infrastructure and deploy commands.
    3. **(K)** First change: something small and reversible (a typo in one title), approved, then checked on eBay. The first 10 changes one at a time, each checked on eBay.
    4. **(K)** One price change and one offer answer watched end to end.
    5. **(K)** First real listing through Add Listing, approved and checked on eBay (photos, postage, collection, specifics).
12. **(K)** About 2026-11-19 (M8): delete the Cloudflare Workers, D1 databases and R2 buckets, and the `.d1-*.sql` exports. **(C)** then removes `wrangler` and the old scripts.

## Decisions for K

1. **Sell screen**: the wizard rewired to the drafts API (recommended), or `Sell.tsx` restyled? (Step 2.)
2. **Sandbox deploys**: may Claude deploy the merged branch to Sandbox when it's ready? (Step 4.)
3. **Parcel2Go**: sandbox credentials when convenient. (Step 6.)
