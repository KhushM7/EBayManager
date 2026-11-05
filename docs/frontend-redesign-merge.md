# Frontend redesign: merge guide

This guide covers what the `claude/frontend-redesign` branch changes, and how to merge it into `azure-migration` (and from there into `main`) without losing anything. The look and motion are described in [design-system.md](design-system.md); this file is about the code.

- **Branch:** `claude/frontend-redesign`, one commit (`2cb7927`), branched from `azure-migration` at `d25fe2b` on 2026-11-05.
- **Since then, `azure-migration` has moved on:** "Add Listing: plan for K's decisions" and "Add Listing: K's decisions recorded" (docs only, `docs/add-listing.md`). These don't touch the frontend.
- **Overlaps with `add-listing`:** that branch adds its own Sell flow. See [Conflicts with `add-listing`](#conflicts-with-add-listing) before merging either.
- **Checks on the branch:** `npm run typecheck`, `npm test` (247 passed, 1 skipped) and `npm run build:web` all pass. Every screen was checked in a browser at 1440px and 390px, dark and light, on `MOCK=1` sample data. It hasn't been deployed or tried on a real phone.
- **Backend:** none changed. No file under `src/` or `test/` was touched, and every API call the screens made before is still made, with the same paths and bodies.

## Files

### Added

| File | What it is |
| --- | --- |
| `web/src/ui.tsx` | Shared kit: the icon set (`Icons`), motion presets (`page`, `list`, `item`, `SPRING`, `EASE_OUT`), `CountUp`, `Sparkline`, `Ring`, `PriceDelta`, `Toasts` and `useToasts`, `CardLabel` |
| `web/src/wizard.tsx` | The New listing wizard at `/new`: five steps (photos, details, description, price, review). Calls three Phase 10 endpoints that don't exist yet (below) |
| `web/src/camera.tsx` | `CameraAssistant` (the photo with a framing grid, a scanning laser while it's checked, then the detected item frame and a score) and `Findings` (the list of what to retake) |
| `web/src/photocheck.ts` | `gradePhoto(file)`: measures a real photo in the browser (brightness, glare, even light, focus, contrast, framing, background clutter, size, shape) against the rules in `listing-assistant.md`. Nothing is generated or altered |
| `docs/design-system.md` | Palette (hex codes, dark and light), type scale, motion timings, the three components K asked for, and the wizard |
| `docs/frontend-redesign-merge.md` | This file |

### Rewritten

| File | What changed | Logic kept |
| --- | --- | --- |
| `web/src/style.css` | Replaced. Imports Tailwind (`@import "tailwindcss"`) and Inter; colour tokens on `:root` with a light-mode override; a `@theme inline` block so Tailwind classes like `bg-surface` and `text-muted` read the tokens. The old class names (`.paper`, `.btn-stamp`, `.btn-ink`, `.state-*`, `.bars`, `.figures`, `.fold`, `.tabs`, `.quote`, `.evidence`, `.flag`, `.result`, `.error`, `.codes`, `.chart-*`, `.door`) are restyled, so screens not rebuilt still match | — |
| `web/src/main.tsx` | New shell: a sidebar on desktop, a floating tab bar on the phone, page transitions, and the environment pill. Routes listed below. The `Aside` summary and the footer are gone | Sign-in, invite, `/me` loading, the waiting count, routing by path |
| `web/src/screens.tsx` | Inbox (swipeable `ProposalCard`, `AllClear` animation, toasts), Listings (`ListingCard`, `Thumb`, `Badge`, totals strip), Activity (timeline), Settings (`Section`, `PeopleCard`, the new `Advanced` section). `useData` and `plural` are now exported. `Aside` was removed | Every API call, the decide and batch logic, `DraftEditor`, `PriceCheck`, `Facts`, push subscribe, devices, people, passkeys, style guide, sold data, sign-out |
| `web/src/metrics.tsx` | Renamed **Insights** on screen. A bento grid: revenue, sell-through `Ring`, days to sell, three `SparklineWidget`s, revenue per day (`Chart`), store health checks, decision counts. Claude's spend chart moved to Settings → Advanced, as figures | `/metrics`, `/nightly`, `daily()`, `FLAG_NAMES` |
| `web/src/report.tsx` | `Report` is shown as **Store Pulse**: a header, a summary card with a ring of six checks that tick in, then the same folded sections | `Facts`, `StyleCard`, `Published`, every folded section, `/firstday` and `/firstday/run` |
| `web/src/todos.tsx` | Cards under "Your assistant suggests"; "From the audit" now reads "Store Pulse" | Every `/todos/:id/:action` call |
| `web/src/logo.tsx` | Same mark (a tag with a tick and eBay's four-colour stripe) on a blue tile; no longer reads CSS variables that were removed | — |

### Small edits

| File | Change |
| --- | --- |
| `package.json`, `package-lock.json` | Added `framer-motion` ^11.18.2, `@fontsource-variable/inter` ^5.2.5, and as dev dependencies `tailwindcss` ^4.1.13 and `@tailwindcss/vite` ^4.1.13. Removed `@fontsource/rokkitt` and `@fontsource/literata` |
| `web/vite.config.ts` | Added the `tailwindcss()` plugin. `@preact/preset-vite` already maps `react` to `preact/compat`, which Framer Motion needs |
| `web/index.html` | `theme-color` for dark (`#07080b`) and light (`#f5f6f9`) |
| `web/public/manifest.webmanifest` | `background_color` and `theme_color` set to `#07080b` |
| `web/mock.ts` | Added a `/solddata` sample (Settings crashed on sample data without it) and the three `/listing-assistant/*` endpoints |
| `CLAUDE.md` | Design line, layout row for `web/`, a "Decisions (2026-11-05)" entry; the tasteskill rules no longer bind the dashboard |
| `docs/app-and-dashboard.md` | Stack line, screen names (Store Pulse, Insights, New listing), the Settings row, the pill instead of the banner |
| `docs/listing-assistant.md` | New section "Wizard API contract (Phase 10)" |

`web/tsconfig.json` is unchanged on purpose. Adding `paths` that point `react` at `preact/compat` broke type-checking of Framer Motion's props. Without them, Framer's types resolve loosely and everything passes.

## Routes

| Path | Before | Now |
| --- | --- | --- |
| `/` | Inbox | Inbox. `/?status=agreed` lists approvals recorded while read-only (linked from Settings → Advanced) |
| `/listings` | Listings | Listings |
| `/new` | — | New listing wizard |
| `/metrics` | Metrics | Insights (same path) |
| `/pulse` | — | Store Pulse |
| `/audit` | Audit | Still works: opens Store Pulse |
| `/activity` | Activity | Activity (desktop sidebar; on the phone via Settings → Advanced) |
| `/settings` | Settings | Settings |

The phone tab bar shows Inbox, Listings, **+** (`/new`), Insights and Settings.

## Behaviour changes to know about

- **Environment banner → pill.** "Sandbox · test account" (amber) or "Live account · read-only" (blue), pinned to the top centre. Nothing is shown on the live account with changes on.
- **Safety cues moved to Settings → Advanced (K's choice):** Pause and resume changes, "Held because", Claude spend, connection and permissions, the last notification, the test notification and the activity log link. Approvals recorded while read-only:
  - no longer carry a "Dry run" tag in the Inbox, and the server's reply after approving still says nothing reached eBay;
  - are listed under "Recorded only", reached from Advanced, not the Inbox tabs.
- **Approving:** swipe a card right (approve) or left (reject), past 120px or with a flick, or use the buttons. Cards can't be dragged while busy or open. Results now appear as toasts, and the card leaves the list.
- **Inbox tabs:** To decide, Applied, Rejected, Refused (was "Refused by eBay"), Expired.
- **Listings thumbnails** are tiles tinted from the item id with the title's initials, because `/listings` returns no picture URL. When listing photos are available, put an `<img>` inside `Thumb`'s moving layer.
- **Theme:** dark by default; light follows the system setting, or `<html data-theme="light">`. There's no toggle in the app yet.
- **Bundle:** the main script is about 88 KB gzipped, up from about 27 KB, mostly Framer Motion. Inter is self-hosted, and the browser fetches only the character sets it needs.

## The wizard's server side (Phase 10, not built)

`wizard.tsx` calls these three endpoints. The contract is in [listing-assistant.md](listing-assistant.md#wizard-api-contract-phase-10), and `MOCK=1` answers all three.

```
POST /api/listing-assistant/describe  { title, condition, facts: { brand, model }, flaws, photoCount } → { description, questions }
POST /api/listing-assistant/price     { title, condition } → { recommended, low, high, basis, postage }
POST /api/listing-assistant/propose   { title, condition, facts, flaws, description, price, postage, collectionOnly } → { proposalId }
```

Against a real server without them, each step shows a toast saying the feature isn't built yet. The draft's text stays in `localStorage` under `ebm.newListingDraft`. Photos stay on the device and are not uploaded.

## Conflicts with `add-listing`

`add-listing` ("Add Listing L1: drafts and photos", on top of `azure-migration`) builds the same feature from the server side:

- `src/photos.ts`, `src/platform/azure/photos.ts`, `src/store/drafts.ts`, and tests;
- a frontend in `web/src/listing/` (`Sell.tsx`, `checks.ts`, `photos.ts`, `listing.css`), routed at **`/sell`**.

| Overlap | `add-listing` | This branch | Suggested resolution |
| --- | --- | --- | --- |
| The Sell flow | `web/src/listing/Sell.tsx` at `/sell`, with real drafts and photo storage | `web/src/wizard.tsx` at `/new`, on the mock contract | Keep one. The backend in `add-listing` is real, so keep its server code and API, then either point the wizard's steps at the drafts and photos endpoints, or move the wizard's visuals into `Sell.tsx` |
| Photo checks | `web/src/listing/checks.ts` | `web/src/photocheck.ts` + `camera.tsx` | Keep one set of rules. The thresholds in `photocheck.ts` come from `listing-assistant.md`; compare them before choosing |
| `web/src/main.tsx` | Adds `import { Sell }` and a `/sell` route to the old `ROUTES` | Rewrites `ROUTES` (each route now has `Icon` and `tab`) and the whole shell | Take this branch's file, then add Sell as one entry (or point the `/new` entry and the tab bar's **+** at it): `{ path: "/sell", label: "Sell", Icon: Icons.plus, View: Sell, tab: true }` |
| `web/src/listing/listing.css` | Styles written for the old tokens (`--paper`, `--ground`, `--ink`, Rokkitt and Literata) | Those tokens no longer exist | Map them to the new ones (`--surface`, `--bg`, `--ink`, `var(--font)`) or restyle with Tailwind classes |
| `package.json` / lockfile | — | New dependencies | Take this branch's `package.json`, then run `npm install` to rebuild the lockfile rather than hand-merging it |

## Suggested merge steps

1. Merge `add-listing` into `azure-migration` first. It's the backend, and it has tests.
2. Merge `claude/frontend-redesign` into `azure-migration`:
   ```bash
   git checkout azure-migration
   git pull
   git merge origin/claude/frontend-redesign
   ```
   Expect conflicts in `web/src/main.tsx`, `package.json` and `package-lock.json`. Resolve them as in the table above, then run:
   ```bash
   npm install
   ```
3. Choose one Sell flow and one set of photo checks, then delete the other files. If you keep `Sell.tsx`, delete `web/src/wizard.tsx`, the three `/listing-assistant/*` routes in `web/mock.ts` and the "Wizard API contract" section of `listing-assistant.md`. Keep `camera.tsx` only if `Sell.tsx` uses it.
4. Check:
   ```bash
   npm run typecheck && npm test && npm run build:web
   ```
   Then on sample data:
   ```bash
   MOCK=1 npm run dev:web
   ```
   Click through Inbox (approve by swipe and button, batch approve, edit a reply draft), Listings (Review with Claude, Check the price, Facts and floor), the Sell flow, Insights (Run now), Store Pulse (Check again), Settings (Advanced open, pause and resume, invite) and the sign-in page (`MOCK=signedout`).
5. Deploy to Sandbox and try it on the phone: swiping, the camera, notifications from the installed app.
6. Open the pull request from `azure-migration` into `main`.
