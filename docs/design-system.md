# Design system

The dashboard PWA's look and motion, decided by K on 2026-11-05. It replaces the tasteskill direction for the app ("parcel labels", Rokkitt and Literata): a premium pro-consumer look in the spirit of Linear, Raycast, Stripe and Family. It uses near-black or soft off-white grounds, crisp cards with 1px inner borders and diffused coloured glows on what you can touch, with native-feeling motion.

Stack: Preact, **Tailwind v4** (`@tailwindcss/vite`) and **Framer Motion** through Preact's compat layer (the Vite preset aliases `react` to `preact/compat`). Tokens live in `web/src/style.css`, and the shared pieces (icons, motion presets, count-up, sparkline, ring, toasts, price pill) live in `web/src/ui.tsx`. Older class names (`.paper`, `.btn-stamp`, `.state-*`) still work and take the new look, so no screen was left behind.

## What changed for K

| Before | Now |
| --- | --- |
| Full-width SANDBOX / READ-ONLY bands | A glowing pill pinned to the top centre. Nothing is shown on the live account with changes on |
| "Audit" | **Store Pulse**: a ring of passed checks that tick in one by one, with the details folded below |
| To-dos | **Your assistant suggests**: cards that lead with what to do |
| Labels with a tear-off stub | Cards you can **swipe right to approve or left to reject**. Buttons too. Old → new price pills roll from the old figure to the new one when a card opens |
| Text rows of listings | A **catalogue**: a thumbnail tile per listing (tinted from its id, parallax zoom on scroll), title on two lines, frosted badges for watchers, views, days listed, floor and collection |
| Metrics as text | **Insights**: a bento grid with revenue counting up, a sell-through ring, sparklines that draw themselves, revenue per day and store health |
| Claude spend, test push, the change switch and "dry run" on every screen | **Settings → Advanced**. Approvals recorded while read-only are listed from there (`/?status=agreed`) |
| — | **New listing** wizard (`/new`, the centre "+" on the phone) |

Navigation: a glass sidebar on desktop, and a floating tab bar on the phone with Inbox, Listings, **+**, Insights and Settings. Store Pulse is linked from Insights, and Activity from Settings → Advanced. `/audit` still opens Store Pulse.

## Colour

Dark is the default; light follows the system setting (or `data-theme="light"` on `<html>`).

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `#07080B` | `#F5F6F9` | Page ground, with two soft pools of accent and green light behind it |
| `--surface` | `#0F1117` | `#FFFFFF` | Cards |
| `--surface-2` | `#151822` | `#F6F7FA` | Wells, inputs, rows inside cards |
| `--surface-3` | `#1C2030` | `#ECEEF4` | Active nav pill, tracks, placeholders |
| `--line` | `rgba(255,255,255,.08)` | `rgba(15,23,42,.08)` | 1px card borders |
| `--line-strong` | `rgba(255,255,255,.14)` | `rgba(15,23,42,.14)` | Controls, glass edges |
| `--ink` | `#F4F5F8` | `#0B0D12` | Text |
| `--ink-2` | `#C7CCD6` | `#2A303C` | Body text inside cards |
| `--muted` | `#9AA1B0` | `#5A6172` | Secondary text (4.5:1 or better on surfaces) |
| `--accent` | `#5B8CFF` | `#2F6BFF` | The primary action, the main data line, focus |
| `--glow` | `rgba(91,140,255,.35)` | `rgba(47,107,255,.28)` | Hover and press glows |

eBay's four colours, made K's own as the four states of a change. Each always comes with a word, and each has a `-soft` tint at about 14% for pill backgrounds:

| State | Dark | Light |
| --- | --- | --- |
| Decide / bad (`--red`) | `#FF5A5F` | `#E0343A` |
| Information (`--blue`) | `#4F8DFF` | `#1F63E6` |
| Held / warning (`--yellow`) | `#FFC23D` | `#B77900` |
| Applied / good (`--green`) | `#36D399` | `#0F9D6B` |

The logo keeps eBay's exact brand colours (`#E53238`, `#0064D2`, `#F5AF02`, `#86B817`) on its tag stripe.

## Type

One family: **Inter Variable** (self-hosted, `@fontsource-variable/inter`), with stylistic sets `cv11 ss01 ss03`, tracking −0.006em on text and −0.025 to −0.04em on headings, and tabular figures on every number.

| Step | Size | Weight | Use |
| --- | --- | --- | --- |
| `--fs-2xl` | 40px (48px on the revenue card at desktop) | 700 | The one answer figure on a screen |
| Page title | 24–32px fluid | 700 | `h1` |
| `--fs-xl` | 28px | 700 | Wizard step titles on the phone, big price changes |
| `--fs-lg` | 20px | 650 | Section headings |
| `--fs-md` | 16px | 400–600 | Body |
| `--fs-base` | 14px | 500–600 | Buttons, nav, rows |
| `--fs-sm` | 13px | 500–600 | Card labels, meta |
| `--fs-xs` | 12px | 600 | Pills, badges, axis labels |

Radii: 10px (small), 16px (cards), 22px (sign-in card and the tab bar); buttons are 12px.

## Motion choreography

Everything respects `prefers-reduced-motion`: Framer's `MotionConfig reducedMotion="user"`, plus a CSS override that drops durations to almost zero.

| Moment | Duration | Easing | Notes |
| --- | --- | --- | --- |
| Press (every button and tappable card) | 120ms | `--ease-out` `cubic-bezier(.16,1,.3,1)` | `scale(.95)`, via `whileTap` or `.btn:active` |
| Hover | 200ms | `--ease-out` | Border tints toward the accent; a soft coloured glow (`0 18px 50px -18px var(--glow)`) |
| Page enter | 420ms | `--ease-out` | Fade, rise of 12px and a 4px blur clearing; `AnimatePresence mode="wait"` |
| Page exit | 180ms | `cubic-bezier(.4,0,1,1)` | Fade and a 6px lift |
| List items | 420ms, 50ms stagger | `--ease-out` | Rise 14px and scale from .98 (`list` / `item` variants) |
| Nav and tab indicators | spring 420 / 32 | — | Shared `layoutId`, so the pill slides between items |
| Count-up numbers | 1.1s | `--ease-out` | From 0 when first scrolled into view (`CountUp`) |
| Sparkline draw | 1.2s, then area fade 0.6s at 0.7s, then end dot | `--ease-out` | `pathLength` 0 → 1 |
| Ring fill | 1.3s at 0.15s | `--ease-out` | Stroke with a drop-shadow glow in its colour |
| Health / Store Pulse checks | 160ms (Insights) or 140ms (Store Pulse) apart | spring | Each tick scales in after its row slides in |
| Price pill | 0.8s at 0.1s | `--ease-out` | Rolls from the old price to the new one when a card opens |
| Card swipe | Drag elastic .55; commit at 120px or 700px/s | — | Approve and Reject words fade in behind the card; the card tilts up to ±4° |
| Toasts | spring 420 / 32 | — | Drop in from the top centre, leave after 3.6s |
| Camera scan | 1.2s loop | `cubic-bezier(.65,0,.35,1)` | A laser line with a glow sweeps down; held at least 1.3s so it reads as a check |
| Claude writing | 1.6s shimmer, 3s border turn | linear | Skeleton lines shimmer inside a turning conic border; the text then types in, three words per 28ms |

## Components

The three components in K's brief, and where they live.

### Listing card (`web/src/screens.tsx`, `ListingCard` and `Thumb`)

```tsx
function Thumb({ l }: { l: Listing }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const scale = useTransform(scrollYProgress, [0, 1], [1.18, 1]); // parallax zoom as it scrolls past
  const y = useTransform(scrollYProgress, [0, 1], ["-6%", "6%"]);
  return (
    <div ref={ref} class="relative aspect-[4/3] overflow-hidden rounded-xl">
      <motion.div style={{ scale, y, background: tileFor(l.item_id) }} class="absolute inset-[-8%] grid place-items-center">
        <span class="text-5xl font-bold tracking-tighter text-white/90">{initials(l.title)}</span>
      </motion.div>
    </div>
  );
}

<motion.li variants={item} layout class="card glow-hover p-3">
  <div class="relative">
    <Thumb l={l} />
    <div class="absolute inset-x-2 top-2 flex gap-1.5">
      <Badge icon={<Icons.heart size={13} />}>{l.watch_count}</Badge>   {/* frosted: bg-black/35 backdrop-blur-md border-white/15 */}
    </div>
  </div>
  <h3 class="line-clamp-2 text-[15px] font-semibold">{l.title}</h3>
  <span class="text-lg font-bold tabular-nums">{money(l.price)}</span>
</motion.li>
```

eBay's API isn't asked for pictures yet, so the thumbnail is a tile tinted from the item id, showing its initials. When listing photos are read (Phase 10), the `<img>` replaces the tile's contents and keeps the parallax.

### Smart Camera Assistant (`web/src/camera.tsx`, graded by `web/src/photocheck.ts`)

`gradePhoto(file)` measures the person's own photo on a 320px copy, and never changes or generates anything. It checks:

- brightness, glare and corner-to-middle evenness
- focus (variance of the Laplacian)
- contrast
- where the item's strong edges sit: framing, centring and coverage
- edge density at the border (a busy background)
- size: at least 500px for eBay, 1600px recommended
- shape: square or 4:3

The thresholds come from [listing-assistant.md](listing-assistant.md#taking-the-photos). Each finding says what to retake and why.

```tsx
<figure class="relative overflow-hidden rounded-2xl" style={{ aspectRatio: "4 / 3" }}>
  <img src={url} class="absolute inset-0 size-full object-cover" />
  {/* rule-of-thirds grid and corner guides */}
  {scanning && (
    <motion.div class="absolute inset-x-0 h-24" initial={{ top: "-25%" }} animate={{ top: ["-25%", "100%"] }}
      transition={{ duration: 1.2, repeat: Infinity, ease: [0.65, 0, 0.35, 1] }}>
      <div class="absolute inset-x-0 bottom-0 h-0.5 bg-accent" style={{ boxShadow: "0 0 12px 2px var(--accent)" }} />
    </motion.div>
  )}
  {grade && (
    <motion.div class="absolute rounded-lg border-2"   /* the detected item frame snaps from the centre to the item */
      animate={{ left: `${grade.box.x * 100}%`, top: `${grade.box.y * 100}%`, width: `${grade.box.w * 100}%`, height: `${grade.box.h * 100}%` }} />
  )}
</figure>
```

The worst finding also appears as a toast ("Lighting is a bit dark…"), and all findings are listed under the photo, worst first.

### Metrics sparkline widget (`web/src/metrics.tsx`, `SparklineWidget`; pieces in `ui.tsx`)

```tsx
export function SparklineWidget({ label, icon, series, format, good = "up" }) {
  const change = series.at(-1) - series[0];
  const better = good === "up" ? change > 0 : change < 0;
  return (
    <motion.div variants={item} class="card glow-hover flex flex-col justify-between gap-4">
      <CardLabel icon={icon}>{label}</CardLabel>
      <div class="flex items-end justify-between gap-3">
        <div>
          <CountUp value={series.at(-1)} format={format} class="text-3xl font-bold tracking-tight" />
          <p class={better ? "text-green" : "text-red"}>{`${change > 0 ? "+" : "−"}${format(Math.abs(change))} in 30 days`}</p>
        </div>
        <Sparkline values={series} width={120} height={44} color={better ? "var(--green)" : "var(--red)"} />
      </div>
    </motion.div>
  );
}
```

`CountUp` ticks from zero with `animate()` on a motion value once `useInView` fires. `Sparkline` draws its path with `pathLength`, fades in a 28% to 0% area under it, then pops its end dot. Colour says good or bad, not up or down, and an unchanged figure stays neutral.

## The New listing wizard

Five steps, each with a large title and one plain sentence on the left and the work on the right (stacked on the phone). A segmented progress bar sits on top, and a floating Back / Next bar is in thumb reach. The text of the draft is kept on the device (`localStorage`) until it's sent; photos are not.

1. **Show it off.** Take a photo (`capture="environment"`), upload, or drag and drop up to 12. Each photo is scanned and graded, and the screen shows the average score with a target of 85.
2. **What is it?** Title (80 characters), optional brand and model ("only if you're sure"), condition as five plain choices, and flaws.
3. **Tell its story.** "Write it with Claude" shows the glowing writing state, then the text types in. It stays editable, and Claude's questions are shown instead of guesses.
4. **Set your price.** Recommended price, a sells-fast-to-patient range with your price marked on it, the basis in words, postage, and collection only.
5. **Ready to list.** A preview card, then **Send for approval**, which creates a `create_listing` proposal. Nothing is published until it's approved.

The server side is Phase 10 and isn't built. The wizard calls the contract in [listing-assistant.md](listing-assistant.md#wizard-api-contract-phase-10). Until it exists, each step says so in a toast and the draft stays on the device. `MOCK=1 npm run dev:web` serves sample answers for all three calls.
