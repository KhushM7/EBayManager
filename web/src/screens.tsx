import { AnimatePresence, LayoutGroup, motion, useMotionValue, useScroll, useTransform, type PanInfo } from "framer-motion";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, apiJob, SignedOut, type Activity as Row, type Device, type Listing, type Me, type Proposal } from "./api";
import { DraftEditor, EDITABLE } from "./drafts";
import { ago, daysSince, describe, money, plural } from "./format";
import { BundleAdvice, PriceCheck } from "./pricing";
import { Todos } from "./todos";
import { Facts, StyleCard } from "./report";
import { CountUp, EASE_OUT, Icons, item, list, PriceDelta, SPRING, Toasts, useToasts } from "./ui";

export interface ScreenProps {
  me: Me;
  reloadMe: () => void;
  onSignedOut: () => void;
  go: (path: string) => void;
  /** Something changed that affects the Inbox count. */
  onChanged: () => void;
}

/** Loads one API path, reloadable; a lost session sends the person to sign-in. */
export function useData<T>(path: string, onSignedOut: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    api<T>(path)
      .then((d) => (setData(d), setError(null)))
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setError(e.message)));
  useEffect(() => {
    reload();
  }, [path]);
  return { data, error, reload };
}

const usd = (n: number) => "$" + (n ?? 0).toFixed(2);

const KIND: Record<string, { label: string; Icon: (p: { size?: number }) => any; tone: string }> = {
  price: { label: "Price change", Icon: Icons.tag, tone: "text-blue bg-blue-soft" },
  revise: { label: "Listing edit", Icon: Icons.sparkles, tone: "text-blue bg-blue-soft" },
  create_listing: { label: "New listing", Icon: Icons.box, tone: "text-green bg-green-soft" },
  message: { label: "Reply to a buyer", Icon: Icons.message, tone: "text-yellow bg-yellow-soft" },
  best_offer_response: { label: "Answer an offer", Icon: Icons.tag, tone: "text-yellow bg-yellow-soft" },
  end_listing: { label: "End listing", Icon: Icons.x, tone: "text-red bg-red-soft" },
  relist: { label: "Relist", Icon: Icons.refresh, tone: "text-blue bg-blue-soft" },
  promote: { label: "Promotion", Icon: Icons.chart, tone: "text-blue bg-blue-soft" },
  policy: { label: "Return policy", Icon: Icons.truck, tone: "text-muted bg-surface-3" },
};
const kindOf = (k: string) => KIND[k] ?? { label: k.replace(/_/g, " "), Icon: Icons.sparkles, tone: "text-muted bg-surface-3" };

const STATE: Record<string, [string, string]> = {
  pending: ["state-decide", "To decide"],
  approved: ["state-held", "Approved, held"],
  applying: ["state-held", "Sending"],
  applied: ["state-applied", "Applied"],
  rejected: ["state-off", "Rejected"],
  expired: ["state-off", "Expired"],
  failed: ["state-decide", "eBay refused it"],
  agreed: ["state-off", "Recorded only"],
};

// ---------------------------------------------------------------- Inbox

// "Recorded only" (approvals made while the account was read-only) is reached from Settings > Advanced.
const STATUSES = [
  { id: "pending", label: "To decide" },
  { id: "applied", label: "Applied" },
  { id: "rejected", label: "Rejected" },
  { id: "failed", label: "Refused" },
  { id: "expired", label: "Expired" },
];

const hasFigure = (p: Proposal) => ["price", "best_offer_response", "create_listing", "promote"].includes(p.kind) || (p.kind === "revise" && Boolean(p.payload?.title));

/** The headline figure of a label. */
function Change({ p, open }: { p: Proposal; open: boolean }) {
  const a = p.payload ?? {};
  if (p.kind === "price") return <PriceDelta from={a.oldPrice ?? null} to={Number(a.newPrice)} open={open} format={money} />;
  if (p.kind === "best_offer_response")
    return a.action === "counter" ? (
      <PriceDelta from={Number(a.offerPrice)} to={Number(a.counterPrice)} open={open} format={money} />
    ) : (
      <span class={`rounded-full px-3 py-1 text-lg font-semibold ${a.action === "accept" ? "bg-green-soft text-green" : "bg-red-soft text-red"}`}>
        {a.action === "accept" ? `Accept ${money(a.offerPrice)}` : "Decline"}
      </span>
    );
  if (p.kind === "create_listing") return <span class="rounded-full bg-green-soft px-3 py-1 text-lg font-semibold tabular-nums text-green">{money(a.price)}</span>;
  if (p.kind === "promote")
    return <span class="rounded-full bg-blue-soft px-3 py-1 text-lg font-semibold tabular-nums text-blue">{a.action === "end" ? "End ad" : `${a.rate}% ad rate`}</span>;
  if (p.kind === "revise" && a.title) return <p class="text-lg leading-snug font-semibold tracking-tight">“{a.title}”</p>;
  return null;
}

/** An empty inbox: a parcel that packs itself and gets its tick. */
function AllClear() {
  return (
    <motion.div class="card flex flex-col items-center gap-4 py-12 text-center" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5, ease: EASE_OUT }}>
      <div class="relative grid size-32 place-items-center">
        <motion.span class="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle, var(--green-soft), transparent 70%)" }} animate={{ scale: [1, 1.18, 1], opacity: [0.9, 0.4, 0.9] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }} />
        <svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden="true">
          {/* box body */}
          <motion.path d="M18 38 48 52 78 38v32L48 84 18 70z" fill="var(--surface-3)" stroke="var(--line-strong)" stroke-width="1.5" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5, ease: EASE_OUT }} />
          <motion.path d="M48 52v32" stroke="var(--line-strong)" stroke-width="1.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.3, duration: 0.4 }} />
          {/* flaps folding shut */}
          <motion.path d="M18 38 48 24 78 38 48 52z" fill="var(--surface-2)" stroke="var(--line-strong)" stroke-width="1.5" style={{ transformOrigin: "48px 38px" }} initial={{ scaleY: -1, opacity: 0 }} animate={{ scaleY: 1, opacity: 1 }} transition={{ delay: 0.45, duration: 0.55, ease: EASE_OUT }} />
          {/* tape */}
          <motion.path d="M33 31l30 14" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 1, duration: 0.4 }} />
          {/* tick */}
          <motion.circle cx="72" cy="22" r="13" fill="var(--green)" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 1.35, ...SPRING }} style={{ filter: "drop-shadow(0 0 10px var(--green))" }} />
          <motion.path d="M66 22l4 4 8-8" stroke="#04130d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 1.55, duration: 0.3 }} />
        </svg>
      </div>
      <div>
        <h2 class="text-xl">You're all caught up</h2>
        <p class="mt-1 text-muted">When Claude suggests a change, it lands here and on your phone.</p>
      </div>
    </motion.div>
  );
}

/** One change waiting for a decision. Swipe right to approve, left to reject, or tap the buttons. */
function ProposalCard({
  p,
  waiting,
  busy,
  selected,
  onToggle,
  onDecide,
  onSaved,
  onSignedOut,
}: {
  p: Proposal;
  waiting: boolean;
  busy: boolean;
  selected: boolean;
  onToggle: () => void;
  onDecide: (d: "approve" | "reject") => void;
  onSaved: () => void;
  onSignedOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const x = useMotionValue(0);
  const approveOpacity = useTransform(x, [20, 120], [0, 1]);
  const rejectOpacity = useTransform(x, [-120, -20], [1, 0]);
  const tilt = useTransform(x, [-200, 200], [-4, 4]);
  const k = kindOf(p.kind);
  const a = p.payload ?? {};
  const { what } = describe(p);
  const [stateClass, stateWord] = STATE[p.status] ?? ["state-info", p.status];
  const itemTitle = p.kind === "revise" ? p.item_title : p.item_title ?? a.itemTitle ?? (p.kind === "create_listing" ? a.title : "");

  const end = (_: unknown, info: PanInfo) => {
    if (!waiting || busy) return;
    if (info.offset.x > 120 || info.velocity.x > 700) onDecide("approve");
    else if (info.offset.x < -120 || info.velocity.x < -700) onDecide("reject");
  };

  return (
    <motion.li
      layout
      variants={item}
      exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: 0.3, ease: EASE_OUT } }}
      class="relative list-none"
    >
      {waiting && (
        <div class="absolute inset-0 flex items-center justify-between overflow-hidden rounded-[var(--radius)] px-6 font-semibold" aria-hidden="true">
          <motion.span style={{ opacity: approveOpacity }} class="flex items-center gap-2 text-green">
            <Icons.check /> Approve
          </motion.span>
          <motion.span style={{ opacity: rejectOpacity }} class="flex items-center gap-2 text-red">
            Reject <Icons.x />
          </motion.span>
        </div>
      )}
      <motion.article
        drag={waiting && !busy && !open ? "x" : false}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.55}
        onDragEnd={end}
        style={{ x, rotate: tilt }}
        whileDrag={{ scale: 1.01, cursor: "grabbing" }}
        class={`card glow-hover touch-pan-y ${selected ? "ring-2 ring-accent" : ""}`}
      >
        <div class="flex items-start gap-3">
          <span class={`grid size-10 flex-none place-items-center rounded-xl ${k.tone}`}>
            <k.Icon size={18} />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span class="font-semibold text-ink">{k.label}</span>
              {!waiting && <span class={`state ${stateClass}`}>{stateWord}</span>}
              <span class="text-muted">· {waiting ? ago(p.created_at) : ago(p.decided_at ?? p.created_at)}</span>
            </div>
            {itemTitle && <p class="mt-0.5 truncate text-sm text-muted">{p.kind === "revise" ? `Now: ${itemTitle}` : itemTitle}</p>}
          </div>
          {waiting && (
            <label class="flex-none cursor-pointer p-1" title="Select">
              <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select: ${what}`} />
            </label>
          )}
        </div>

        <button class="mt-4 flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span class="min-w-0">{hasFigure(p) ? <Change p={p} open={open} /> : <span class="text-lg font-semibold tracking-tight">{what}</span>}</span>
          <motion.span animate={{ rotate: open ? 180 : 0 }} class="flex-none text-muted">
            <Icons.chevron />
          </motion.span>
        </button>

        {(a.flags ?? []).length > 0 && (
          <div class="mt-3 flex flex-wrap">
            {(a.flags as string[]).map((f) => (
              <span class="flag">
                <Icons.alert size={14} /> {f}
              </span>
            ))}
          </div>
        )}

        <AnimatePresence initial={false}>
          {open && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35, ease: EASE_OUT }} class="overflow-hidden">
              <div class="pt-4 text-[15px] text-ink-2">
                {EDITABLE.includes(p.kind) && waiting ? (
                  <DraftEditor p={p} onSaved={onSaved} onSignedOut={onSignedOut} />
                ) : (
                  p.kind === "message" && a.body && <p class="quote">{a.body}</p>
                )}
                {p.kind === "revise" && a.itemSpecifics && (
                  <p class="quote text-sm">
                    {Object.entries(a.itemSpecifics)
                      .map(([kk, v]) => `${kk}: ${[v].flat().join(", ")}`)
                      .join(" · ")}
                  </p>
                )}
                {p.reason && p.kind !== "message" && (
                  <p class="flex gap-2">
                    <Icons.sparkles size={16} class="mt-1 flex-none text-accent" />
                    <span>{p.reason}</span>
                  </p>
                )}
                {p.kind === "promote" && (
                  <p class="text-sm text-muted">
                    {a.campaign}. eBay suggests {a.suggestedRate != null ? `${a.suggestedRate}%` : "no rate"}
                    {a.payback ? `; expected sale in about ${a.payback.daysPromoted} days instead of ${a.payback.daysNow}, ad fee ${money(a.payback.adFee)} if it sells through the ad.` : "."}
                  </p>
                )}
                {p.kind === "policy" && a.proposed && (
                  <p class="text-sm text-muted">
                    {a.name}: returns accepted within {a.proposed.periodDays} days, buyer pays return postage.
                  </p>
                )}
                <p class="mt-2 text-xs text-muted">
                  {waiting ? `Expires ${ago(p.expires_at)}` : `${stateWord} ${ago(p.decided_at ?? p.created_at)}`}
                  {p.decided_by ? ` by ${p.decided_by}` : ""}
                  {p.item_id ? ` · item ${p.item_id}` : ""}
                </p>
                {!waiting && p.result && <p class="mt-1 text-sm">{p.result}</p>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {waiting && (
          <div class="mt-4 flex items-center gap-2">
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-approve flex-1 sm:flex-none" disabled={busy} onClick={() => onDecide("approve")}>
              <Icons.check size={18} /> Approve
            </motion.button>
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" disabled={busy} onClick={() => onDecide("reject")}>
              Reject
            </motion.button>
            <span class="ml-auto hidden text-xs text-muted sm:inline">Swipe or tap</span>
          </div>
        )}
      </motion.article>
    </motion.li>
  );
}

export function Inbox({ me, onSignedOut, onChanged }: ScreenProps) {
  const initial = new URLSearchParams(location.search).get("status") ?? "pending";
  const [status, setStatus] = useState(initial);
  const { data, error, reload } = useData<Proposal[]>(`/proposals?status=${status}`, onSignedOut);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [todoCount, setTodoCount] = useState(0);
  const toasts = useToasts();

  useEffect(() => (setSelected(new Set()), setGone(new Set())), [status]);

  const decide = async (ids: string[], decision: "approve" | "reject") => {
    setBusy(true);
    try {
      const { results: out } = await api<{ results: { id: string; result: string }[] }>("/proposals/decide", { body: { ids, decision } });
      setGone((g) => new Set([...g, ...ids]));
      for (const r of out.slice(0, 2)) toasts.push(decision === "approve" ? "good" : "info", r.result);
      if (out.length > 2) toasts.push("good", `${out.length} decided.`);
      setSelected(new Set());
      setTimeout(() => (reload(), onChanged()), 900);
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else toasts.push("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const rows = (data ?? []).filter((p) => !gone.has(p.id));
  const waiting = status === "pending";
  const summary = [todoCount && plural(todoCount, "suggestion"), rows.length && `${rows.length} to decide`].filter(Boolean).join(" · ");
  return (
    <div class="max-w-3xl">
      <div class="page-head">
        <div>
          <h1>Inbox</h1>
          <p>{waiting ? (data ? summary || "Nothing needs you right now." : "Checking…") : status === "agreed" ? "Approvals recorded while the account was read-only. None of these reached eBay." : "Changes already decided."}</p>
        </div>
      </div>

      {waiting && me.writesBlocked && (
        <div class="mb-4 flex items-center gap-3 rounded-2xl border border-line bg-yellow-soft px-4 py-3 text-sm text-yellow">
          <Icons.clock size={18} /> Approved changes wait for now: {me.writesBlocked.toLowerCase()}.
        </div>
      )}

      {waiting && <Todos me={me} onSignedOut={onSignedOut} onCount={setTodoCount} onChanged={onChanged} />}
      {waiting && <BundleAdvice onSignedOut={onSignedOut} />}

      <div class={waiting && todoCount ? "section" : ""}>
        {waiting && todoCount > 0 && <h2 class="inbox-sub">Changes to approve</h2>}
        <LayoutGroup id="inbox-tabs">
          <div class="tabs" role="tablist">
            {(status === "agreed" ? [...STATUSES, { id: "agreed", label: "Recorded only" }] : STATUSES).map((s) => (
              <button role="tab" aria-selected={s.id === status} class="tab" onClick={() => setStatus(s.id)}>
                {s.id === status && <motion.span layoutId="inbox-tab" class="tab-active" transition={SPRING} />}
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        </LayoutGroup>

        {error && <p class="error">{error}</p>}
        {!data && !error && (
          <div class="grid gap-3">
            {[0, 1].map((i) => (
              <div key={i} class="card">
                <div class="skeleton h-4 w-40" />
                <div class="skeleton mt-4 h-8 w-56" />
              </div>
            ))}
          </div>
        )}
        {data && !rows.length && (waiting ? !todoCount && <AllClear /> : <p class="card text-muted">None yet.</p>)}
        {data && !rows.length && waiting && todoCount > 0 && <p class="card text-muted">No changes waiting. Your suggestions are above.</p>}

        <motion.ol class="grid gap-3 p-0" variants={list} initial="hidden" animate="show">
          <AnimatePresence initial={false}>
            {rows.map((p) => (
              <ProposalCard
                key={p.id}
                p={p}
                waiting={waiting}
                busy={busy}
                selected={selected.has(p.id)}
                onToggle={() => toggle(p.id)}
                onDecide={(d) => decide([p.id], d)}
                onSaved={reload}
                onSignedOut={onSignedOut}
              />
            ))}
          </AnimatePresence>
        </motion.ol>
      </div>

      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div class="batch" role="region" aria-label="Selected changes" initial={{ y: 40, opacity: 0, x: "-50%" }} animate={{ y: 0, opacity: 1, x: "-50%" }} exit={{ y: 40, opacity: 0, x: "-50%" }} transition={SPRING}>
            <span>{plural(selected.size, "change")} selected</span>
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-approve" disabled={busy} onClick={() => decide([...selected], "approve")}>
              Approve {selected.size}
            </motion.button>
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-text" disabled={busy} onClick={() => decide([...selected], "reject")}>
              Reject
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        <Toasts items={toasts.items} />
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------- Listings

// The thumbnail: the listing's main picture from eBay (read with the listings, no extra call). Without one, or if
// it fails to load, the listing gets a tile tinted from its own id with its initials. Either drifts and zooms
// gently as the card scrolls past (parallax).
const HUES = [222, 158, 38, 352, 200, 268, 12, 120];
function Thumb({ l }: { l: Listing }) {
  const ref = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  const { scrollYProgress } = useScroll({ target: ref as any, offset: ["start end", "end start"] });
  const scale = useTransform(scrollYProgress, [0, 1], [1.18, 1]);
  const y = useTransform(scrollYProgress, [0, 1], ["-6%", "6%"]);
  const hue = HUES[Number(l.item_id.slice(-3)) % HUES.length];
  const words = l.title.replace(/^TEST\s+/i, "").split(/\s+/);
  const initials = (words[0]?.[0] ?? "") + (words[1]?.[0] ?? "");
  return (
    <div ref={ref} class="relative aspect-[4/3] overflow-hidden rounded-xl">
      {l.image_url && !broken ? (
        <motion.div style={{ scale, y }} class="absolute inset-[-8%] bg-surface-3">
          <img src={l.image_url} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} class="size-full object-cover" />
        </motion.div>
      ) : (
      <motion.div
        style={{ scale, y, background: `radial-gradient(120% 90% at 20% 10%, hsl(${hue} 90% 70% / .55), transparent 60%), radial-gradient(100% 80% at 90% 100%, hsl(${(hue + 50) % 360} 90% 60% / .45), transparent 60%), var(--surface-3)` }}
        class="absolute inset-[-8%] grid place-items-center"
      >
        <span class="text-5xl font-bold tracking-tighter text-white/90 drop-shadow-lg">{initials.toUpperCase()}</span>
      </motion.div>
      )}
    </div>
  );
}

function Badge({ icon, children, tone = "" }: { icon: any; children: any; tone?: string }) {
  return (
    <span class={`inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/35 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-md ${tone}`}>
      {icon}
      {children}
    </span>
  );
}

function ListingCard({ l, me, onSignedOut, onChanged, go, reload }: { l: Listing; reload: () => void } & Pick<ScreenProps, "me" | "onSignedOut" | "onChanged" | "go">) {
  const [review, setReview] = useState<{ busy?: boolean; note?: string; error?: string }>({});
  const owner = me.user.role === "owner";
  const days = daysSince(l.start_time);
  const run = async () => {
    setReview({ busy: true });
    try {
      const out = await apiJob<{ note: string; costUsd: number }>("/audit", { itemId: l.item_id });
      setReview({ note: out.note || "Done." });
      reload();
      onChanged();
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setReview({ error: (e as Error).message });
    }
  };
  return (
    <motion.li variants={item} layout class="card glow-hover list-none p-3">
      <div class="relative">
        <Thumb l={l} />
        <div class="absolute inset-x-2 top-2 flex flex-wrap gap-1.5">
          <Badge icon={<Icons.heart size={13} />}>{l.watch_count ?? 0}</Badge>
          {l.view_count != null && <Badge icon={<Icons.eye size={13} />}>{l.view_count}</Badge>}
          <Badge icon={<Icons.calendar size={13} />}>{days}d</Badge>
        </div>
        <div class="absolute inset-x-2 bottom-2 flex flex-wrap gap-1.5">
          {l.floor_price != null && <Badge icon={<Icons.tag size={13} />}>Floor {money(l.floor_price)}</Badge>}
          {l.collection_only ? <Badge icon={<Icons.truck size={13} />}>Collection</Badge> : null}
        </div>
      </div>
      <div class="px-1 pt-3">
        <div class="flex items-start justify-between gap-3">
          <h3 class="line-clamp-2 text-[15px] leading-snug font-semibold" title={l.title}>
            {l.title}
          </h3>
          <span class="text-lg font-bold tabular-nums tracking-tight">{money(l.price)}</span>
        </div>
        {l.pending > 0 && (
          <button class="mt-2 inline-flex items-center gap-1.5 rounded-full bg-red-soft px-2.5 py-1 text-xs font-semibold text-red" onClick={() => go("/")}>
            <span class="size-1.5 rounded-full bg-red" /> {plural(l.pending, "change")} waiting
          </button>
        )}
        {review.note && <p class="result mt-3">{review.note}</p>}
        {review.error && <p class="error mt-3">{review.error}</p>}
        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-sm">
          <button class="btn-link inline-flex items-center gap-1.5" disabled={review.busy} onClick={run}>
            {review.busy ? (
              <>
                <span class="size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" /> Reviewing…
              </>
            ) : (
              <>
                <Icons.sparkles size={15} /> Review with Claude
              </>
            )}
          </button>
          {owner && <PriceCheck itemId={l.item_id} current={Number(l.price)} onSignedOut={onSignedOut} onChanged={onChanged} />}
        </div>
        {owner && <Facts itemId={l.item_id} hasFloor={l.floor_price != null} onSignedOut={onSignedOut} />}
        <p class="mt-2 text-xs text-muted">Item {l.item_id}</p>
      </div>
    </motion.li>
  );
}

export function Listings({ me, onSignedOut, onChanged, go }: ScreenProps) {
  const { data, error, reload } = useData<Listing[]>("/listings", onSignedOut);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api("/listings/refresh", { body: {} });
      await reload();
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
    } finally {
      setRefreshing(false);
    }
  };

  const rows = data ?? [];
  const total = rows.reduce((s, l) => s + Number(l.price) * Number(l.quantity_available || 1), 0);
  const watchers = rows.reduce((s, l) => s + Number(l.watch_count || 0), 0);
  return (
    <>
      <div class="page-head">
        <div>
          <h1>Listings</h1>
          <p>{data ? (rows.length ? `Read from eBay ${ago(rows[0].taken_at)}.` : "Nothing read from eBay yet.") : "Loading…"}</p>
        </div>
        <div class="flex gap-2">
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            <motion.span animate={refreshing ? { rotate: 360 } : { rotate: 0 }} transition={refreshing ? { repeat: Infinity, duration: 1, ease: "linear" } : {}}>
              <Icons.refresh size={16} />
            </motion.span>
            {refreshing ? "Reading eBay" : "Refresh"}
          </motion.button>
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" onClick={() => go("/new")}>
            <Icons.plus size={16} /> New listing
          </motion.button>
        </div>
      </div>

      {data && rows.length > 0 && (
        <div class="mb-5 grid grid-cols-3 gap-3">
          {[
            { label: "Live listings", value: rows.length, fmt: (n: number) => String(Math.round(n)) },
            { label: "Asking in total", value: total, fmt: money },
            { label: "Watchers", value: watchers, fmt: (n: number) => String(Math.round(n)) },
          ].map((s) => (
            <div class="card px-4 py-3">
              <p class="text-xs font-semibold text-muted sm:text-sm">{s.label}</p>
              <CountUp value={s.value} format={s.fmt} class="text-xl font-bold tracking-tight sm:text-2xl" />
            </div>
          ))}
        </div>
      )}

      {error && <p class="error">{error}</p>}
      {data && !rows.length && (
        <div class="card flex flex-col items-start gap-3">
          <p>No listings read yet.</p>
          <button class="btn btn-primary" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Reading eBay" : "Read them from eBay"}
          </button>
        </div>
      )}
      {!data && !error && (
        <div class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} class="card p-3">
              <div class="skeleton aspect-[4/3] w-full" />
              <div class="skeleton mt-3 h-4 w-3/4" />
            </div>
          ))}
        </div>
      )}
      <motion.ol class="m-0 grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] items-start gap-4 p-0" variants={list} initial="hidden" animate="show">
        {rows.map((l) => (
          <ListingCard key={l.item_id} l={l} me={me} onSignedOut={onSignedOut} onChanged={onChanged} go={go} reload={reload} />
        ))}
      </motion.ol>
    </>
  );
}

// ---------------------------------------------------------------- Activity

const OUTCOME: Record<Row["outcome"], [string, string, string]> = {
  applied: ["state-applied", "Applied", "var(--green)"],
  refused: ["state-held", "Stopped by the safety gate", "var(--yellow)"],
  failed: ["state-decide", "eBay refused it", "var(--red)"],
};

export function Activity({ onSignedOut }: ScreenProps) {
  const { data, error } = useData<Row[]>("/activity", onSignedOut);
  const rows = data ?? [];
  return (
    <div class="max-w-3xl">
      <div class="page-head">
        <div>
          <h1>Activity</h1>
          <p>Every change sent to eBay, and who approved it.</p>
        </div>
      </div>
      {error && <p class="error">{error}</p>}
      {data && !rows.length && <p class="card text-muted">Nothing has been sent yet.</p>}
      <motion.ol class="relative m-0 grid gap-2 p-0 pl-6" variants={list} initial="hidden" animate="show">
        <span class="absolute top-2 bottom-2 left-[7px] w-px bg-line-strong" aria-hidden="true" />
        {rows.map((a) => {
          const [cls, word, color] = OUTCOME[a.outcome] ?? ["state-info", a.outcome, "var(--blue)"];
          return (
            <motion.li variants={item} class="relative list-none" key={a.id}>
              <span class="absolute top-5 -left-[22px] size-3 rounded-full" style={{ background: color, boxShadow: `0 0 0 4px var(--bg), 0 0 12px ${color}` }} />
              <div class="card py-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-semibold">{kindOf(a.kind ?? "").label === (a.kind ?? "") ? a.call : kindOf(a.kind ?? "").label}</span>
                  <span class="text-xs text-muted">{ago(a.at)}</span>
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                  <span class={`state ${cls}`}>{word}</span>
                  {a.item_id && <span>item {a.item_id}</span>}
                  {a.actor && <span>· approved by {a.actor}</span>}
                </div>
                {a.outcome !== "applied" && a.response && <p class="mt-2 text-sm text-muted">{a.response}</p>}
              </div>
            </motion.li>
          );
        })}
      </motion.ol>
    </div>
  );
}

// ---------------------------------------------------------------- Settings

interface Allowance {
  id: string;
  name: string;
  left: number | null;
  total: number | null;
  unit: "usd" | "searches";
  summary: string;
  notes: string[];
  level: "ok" | "low" | "out" | "unknown" | "off";
  keys?: { slot: number; left: number; total: number; inUse: boolean; reported: boolean }[];
}

interface Usage {
  today: { usd: number; calls: number };
  month: { usd: number; calls: number };
  byJob: { job: string; calls: number; usd: number }[];
  dailyBudgetUsd: number;
  apiKeySet: boolean;
  allowances?: Allowance[];
  services?: ServiceStatus[];
}

interface ServiceStatus {
  id: string;
  name: string;
  level: "ok" | "failing" | "down";
  summary: string;
}

interface People {
  people: { id: string; name: string; role: string; email: string }[];
}

const JOB_NAMES: Record<string, string> = {
  audit: "Listing reviews",
  triage: "Nightly checks",
  reply: "Reply drafts",
  offer: "Offer suggestions",
  specs: "Specification lookups",
  listing: "New listings",
  pricing: "Pricing",
  bundles: "Bundle advice",
  style: "Reply style",
};

const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function deviceName(ua: string | null) {
  if (!ua) return "A device";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "A device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os}, ${browser}` : os;
}

function Section({ title, sub, children, class: cls = "" }: { title: string; sub?: string; children: any; class?: string }) {
  return (
    <section class={`card ${cls}`}>
      <h2 class="text-base">{title}</h2>
      {sub && <p class="mt-1 text-sm text-muted">{sub}</p>}
      <div class="mt-4">{children}</div>
    </section>
  );
}

type Run = (fn: () => Promise<string | void>) => void;
type SectionId = "account" | "notifications" | "connection" | "style" | "usage";

const SECTIONS: { id: SectionId; title: string; Icon: (p: { size?: number }) => any }[] = [
  { id: "account", title: "Account", Icon: Icons.user },
  { id: "notifications", title: "Notifications", Icon: Icons.bell },
  { id: "connection", title: "eBay connection", Icon: Icons.link },
  { id: "style", title: "Reply style", Icon: Icons.message },
  { id: "usage", title: "Usage and APIs", Icon: Icons.gauge },
];

/** The open section, kept in the address (?s=) so the phone's back button closes it. */
function useSettingsSection(): [SectionId | null, (s: SectionId | null) => void] {
  const read = () => {
    const s = new URLSearchParams(location.search).get("s");
    return SECTIONS.some((x) => x.id === s) ? (s as SectionId) : null;
  };
  const [section, setSection] = useState<SectionId | null>(read);
  useEffect(() => {
    const on = () => setSection(read());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const open = (s: SectionId | null) => {
    if (s === section) return;
    if (s && !section) history.pushState(null, "", `/settings?s=${s}`);
    else history.replaceState(null, "", s ? `/settings?s=${s}` : "/settings");
    setSection(s);
  };
  return [section, open];
}

function useWide() {
  const q = typeof matchMedia === "undefined" ? null : matchMedia("(min-width: 1024px)");
  const [wide, setWide] = useState(q?.matches ?? false);
  useEffect(() => {
    if (!q) return;
    const on = () => setWide(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return wide;
}

/** At the top of Settings: whether changes reach eBay, and the switch to pause them all. */
function ChangesCard({ me, reloadMe, run, busy, go }: { me: Me; reloadMe: () => void; run: Run; busy: boolean; go: (p: string) => void }) {
  const owner = me.user.role === "owner";
  const live = me.writeMode === "approval";
  const state = !live ? "Read-only" : me.writesPaused ? "Paused" : "Applied after approval";
  const tone = !live ? "var(--muted)" : me.writesPaused ? "var(--yellow)" : "var(--green)";
  return (
    <section class="card mb-5">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex min-w-0 items-center gap-3">
          <span class="relative grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-2">
            <span class="size-3 rounded-full" style={{ background: tone, boxShadow: `0 0 14px ${tone}` }} />
          </span>
          <span class="min-w-0">
            <span class="block text-sm text-muted">Changes to eBay</span>
            <span class="block text-lg font-semibold tracking-tight">{state}</span>
          </span>
        </div>
        {live &&
          (me.writesPaused ? (
            owner ? (
              <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={busy} onClick={() => run(async () => (await api("/settings/writes", { body: { paused: false } }), reloadMe(), "Changes resumed."))}>
                <Icons.play size={16} /> Resume changes
              </motion.button>
            ) : (
              <p class="text-sm text-muted">Only the owner can resume changes.</p>
            )
          ) : (
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-danger" disabled={busy} onClick={() => run(async () => (await api("/settings/writes", { body: { paused: true } }), reloadMe(), "All changes paused."))}>
              <Icons.pause size={16} /> Pause all changes
            </motion.button>
          ))}
      </div>
      {me.writesBlocked && (
        <p class="mt-3 text-sm">
          <span class="text-muted">Held because:</span> {me.writesBlocked}
        </p>
      )}
      <p class="mt-3 text-xs text-muted">Anyone can pause. Approvals made while paused or read-only are recorded but don't reach eBay.</p>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <button class="btn-link" onClick={() => go("/activity")}>
          Change history
        </button>
        <button class="btn-link" onClick={() => (location.href = "/?status=agreed")}>
          Approvals recorded while read-only
        </button>
      </div>
    </section>
  );
}

function PeopleCard({ onSignedOut }: { onSignedOut: () => void }) {
  const people = useData<People>("/people", onSignedOut);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signOut = async (id: string, name: string) => {
    setError(null);
    setNote(null);
    try {
      await api(`/people/${id}/signout`, { body: {} });
      setNote(`${name} is signed out on every device.`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const d = people.data;
  return (
    <Section title="People" sub="Who can sign in. You set them up on your computer with scripts/people.mjs; the app can't add or change anyone.">
      {d && (
        <ul class="grid gap-2 p-0">
          {d.people.map((p) => (
            <li class="flex list-none flex-wrap items-center gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5" key={p.id}>
              <span class="avatar">{p.name.slice(0, 1).toUpperCase()}</span>
              <span class="min-w-0 flex-1">
                <span class="block font-semibold">
                  {p.name} <span class="text-sm font-normal text-muted">· {p.role}</span>
                </span>
                <span class="block truncate text-xs text-muted">{p.email}</span>
              </span>
              <button class="btn-link text-sm" onClick={() => signOut(p.id, p.name)}>
                Sign out everywhere
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <p class="mt-3 text-sm text-muted">{note}</p>}
      {error && <p class="error mt-3">{error}</p>}
    </Section>
  );
}

function AccountSection({ me, onSignedOut, run, busy }: { me: Me; onSignedOut: () => void; run: Run; busy: boolean }) {
  const owner = me.user.role === "owner";
  return (
    <div class="grid gap-4">
      <Section title="Your account" sub="You sign in with your email and the code from your authenticator app.">
        <dl class="figures">
          <div>
            <dt>Name</dt>
            <dd>{me.user.name}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{owner ? "Owner" : "Manager"}</dd>
          </div>
        </dl>
        <div class="mt-4 flex flex-wrap gap-2">
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" disabled={busy} onClick={() => run(async () => (await api("/logout", { body: {} }), onSignedOut()))}>
            Sign out of this device
          </motion.button>
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" disabled={busy} onClick={() => run(async () => (await api(`/people/${me.user.id}/signout`, { body: {} }), onSignedOut()))}>
            Sign out on all my devices
          </motion.button>
        </div>
      </Section>
      {owner && <PeopleCard onSignedOut={onSignedOut} />}
    </div>
  );
}

function NotificationsSection({ me, run, busy, devices, permission, enablePush }: { me: Me; run: Run; busy: boolean; devices: ReturnType<typeof useData<Device[]>>; permission: string; enablePush: () => void }) {
  const devs = devices.data ?? [];
  return (
    <Section title="Notifications" sub="Approve or reject straight from the notification on your phone.">
      <div class="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
        <span>
          <span class="block font-semibold">This device</span>
          <span class="text-sm text-muted">{permission === "granted" ? "Notifications on" : permission === "denied" ? "Blocked in the browser" : permission === "unsupported" ? "Not supported here" : "Off"}</span>
        </span>
        {permission !== "unsupported" && permission !== "granted" && (
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={busy} onClick={enablePush}>
            Turn on
          </motion.button>
        )}
        {permission === "granted" && <span class="state state-applied">On</span>}
      </div>
      {devs.length > 0 && (
        <>
          <h3 class="mt-5 mb-2 text-sm text-muted">Devices that get notifications</h3>
          <ul class="grid gap-2 p-0">
            {devs.map((d) => (
              <li class="flex list-none items-center justify-between gap-3 px-1 text-sm" key={d.endpoint}>
                <span>
                  {deviceName(d.user_agent)} <span class="text-muted">· added {ago(d.created_at)}</span>
                  {d.last_error && <span class="block text-xs text-red">Last error: {d.last_error}</span>}
                </span>
                <button class="btn-link" onClick={() => run(async () => (await api("/push/unsubscribe", { body: { endpoint: d.endpoint } }), await devices.reload()))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <dl class="figures mt-4">
        <div>
          <dt>Last notification sent</dt>
          <dd>{ago(me.lastPushAt)}</dd>
        </div>
      </dl>
      <p class="mt-3 text-xs text-muted">On Android: open this site in Chrome, choose Install app, then turn notifications on here.</p>
    </Section>
  );
}

function ConnectionSection({ me }: { me: Me }) {
  const owner = me.user.role === "owner";
  return (
    <Section title="eBay connection" sub="The eBay account this app reads, and what it's allowed to do there.">
      <dl class="figures">
        <div>
          <dt>eBay account</dt>
          <dd>{me.ebayEnv === "production" ? "Live" : "Sandbox"}</dd>
        </div>
        <div>
          <dt>Connected</dt>
          <dd>{me.ebayConnected ? (me.ebayNeedsReconnect ? "Sign-in rejected" : "Yes") : "Not yet"}</dd>
        </div>
        <div>
          <dt>Permissions</dt>
          <dd>{me.ebayConnected ? (me.ebayScopes === "read-only" ? "Read-only" : "Full") : "None"}</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>{me.writeMode !== "approval" ? "Read-only" : "After approval"}</dd>
        </div>
      </dl>
      {owner && !me.ebayConnected && (
        <p class="mt-4">
          <a class="btn btn-primary" href="/oauth/start">
            Connect your eBay account
          </a>
        </p>
      )}
      {me.ebayConnected && me.ebayNeedsReconnect && (
        <div class="evidence mt-4" role="alert">
          <p class="text-sm font-semibold">eBay has stopped accepting the app's sign-in.</p>
          <p class="mt-1 text-sm">
            This happens when the eBay username or password changes. Until you sign in again, the app can't read listings, orders or buyer messages, or send approved changes.
          </p>
          {owner ? (
            <p class="mt-3">
              <a class="btn btn-primary" href="/oauth/start">
                Reconnect eBay
              </a>
            </p>
          ) : (
            <p class="mt-2 text-sm text-muted">Only the owner can reconnect eBay.</p>
          )}
        </div>
      )}
      {owner && me.ebayConnected && !me.ebayNeedsReconnect && me.writeMode === "approval" && me.ebayScopes === "read-only" && (
        <div class="evidence mt-4">
          <p class="text-sm">Changes are switched on, but eBay is still connected read-only, so approved changes can't be sent yet. Sign in to eBay again and accept the full permission.</p>
          <p class="mt-3">
            <a class="btn btn-primary" href="/oauth/start">
              Give eBay full permission
            </a>
          </p>
        </div>
      )}
    </Section>
  );
}

const LEVEL: Record<Allowance["level"], { word: string; cls: string; bar: string }> = {
  ok: { word: "OK", cls: "state-applied", bar: "var(--green)" },
  low: { word: "Running low", cls: "state-held", bar: "var(--yellow)" },
  out: { word: "Used up", cls: "state-decide", bar: "var(--red)" },
  unknown: { word: "Balance needed", cls: "state-info", bar: "var(--blue)" },
  off: { word: "Not set up", cls: "state-off", bar: "var(--muted)" },
};

const SERVICE_LEVEL: Record<ServiceStatus["level"], { word: string; cls: string }> = {
  ok: { word: "Working", cls: "state-applied" },
  failing: { word: "Retrying", cls: "state-held" },
  down: { word: "Not working", cls: "state-decide" },
};

function AllowanceRow({ a }: { a: Allowance }) {
  const l = LEVEL[a.level];
  const share = a.left != null && a.total ? Math.max(0, Math.min(1, a.left / a.total)) : null;
  return (
    <li class="list-none rounded-xl border border-line bg-surface-2 px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-semibold">{a.name}</span>
        <span class={`state ${l.cls}`}>{l.word}</span>
      </div>
      <p class="mt-1 text-lg font-bold tabular-nums tracking-tight">{a.summary}</p>
      {a.keys && a.keys.length > 1 ? (
        <ul class="mt-2 grid gap-2 p-0">
          {a.keys.map((k) => (
            <li class="list-none" key={k.slot}>
              <div class="flex items-center justify-between gap-2 text-sm">
                <span class="font-semibold">
                  Key {k.slot} {k.inUse && <span class="state state-applied ml-1">In use</span>}
                </span>
                <span class="tabular-nums text-muted">{k.left <= 0 ? "Used up" : `${k.left} of ${k.total} left`}</span>
              </div>
              <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuemin={0} aria-valuemax={k.total} aria-valuenow={k.left} aria-label={`${a.name} key ${k.slot} left`}>
                <motion.div class="h-full rounded-full" style={{ background: k.left <= 0 ? "var(--red)" : k.left / k.total < 0.1 ? "var(--yellow)" : "var(--green)" }} initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(1, k.left / k.total)) * 100}%` }} transition={{ duration: 0.8, ease: EASE_OUT }} />
              </div>
            </li>
          ))}
        </ul>
      ) : share != null && (
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuemin={0} aria-valuemax={a.total ?? 0} aria-valuenow={a.left ?? 0} aria-label={`${a.name} left`}>
          <motion.div class="h-full rounded-full" style={{ background: l.bar }} initial={{ width: 0 }} animate={{ width: `${share * 100}%` }} transition={{ duration: 0.8, ease: EASE_OUT }} />
        </div>
      )}
      {a.notes.map((n) => (
        <p class="mt-1.5 text-xs text-muted">{n}</p>
      ))}
    </li>
  );
}

function CreditForm({ usage, run, busy, reload }: { usage: Usage; run: Run; busy: boolean; reload: () => void }) {
  const [value, setValue] = useState("");
  const save = (usd: string | null) =>
    run(async () => {
      await api("/usage/credit", { body: { usd } });
      setValue("");
      reload();
      return usd == null ? "Balance cleared." : "Saved. What's left counts down from here.";
    });
  const claude = usage.allowances?.find((a) => a.id === "claude");
  return (
    <form
      class="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) save(value.trim());
      }}
    >
      <label class="block text-sm font-semibold" for="credit">
        Claude credit balance
      </label>
      <p class="mt-1 text-xs text-muted">Enter the balance shown in the Claude Console (Billing) after each top-up. Anthropic doesn't share it with the app.</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <input id="credit" class="max-w-40" inputMode="decimal" placeholder="e.g. 12.50" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={busy || !value.trim()} type="submit">
          Save
        </motion.button>
        {claude?.total != null && (
          <button type="button" class="btn btn-text" disabled={busy} onClick={() => save(null)}>
            Clear
          </button>
        )}
      </div>
    </form>
  );
}

function UsageSection({ me, usage, run, busy }: { me: Me; usage: ReturnType<typeof useData<Usage>>; run: Run; busy: boolean }) {
  const owner = me.user.role === "owner";
  const u = usage.data;
  if (!u) return <div class="card">{usage.error ? <p class="error">{usage.error}</p> : <div class="skeleton h-40" />}</div>;
  return (
    <div class="grid gap-4">
      <Section title="What's left" sub="Paid allowances the app uses. When one runs low or out, you get a to-do in the Inbox and a notification.">
        <ul class="grid gap-2 p-0">
          {(u.allowances ?? []).map((a) => (
            <AllowanceRow a={a} key={a.id} />
          ))}
        </ul>
        {owner && <CreditForm usage={u} run={run} busy={busy} reload={usage.reload} />}
      </Section>
      {u.services && (
        <Section title="Outside services" sub="Whether eBay, Claude, the sold-price providers and Parcel2Go are answering. When one stops working, you get a to-do in the Inbox and a notification.">
          <ul class="grid gap-2 p-0">
            {u.services.map((s) => (
              <li class="list-none rounded-xl border border-line bg-surface-2 px-4 py-3" key={s.id}>
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-semibold">{s.name}</span>
                  <span class={`state ${SERVICE_LEVEL[s.level].cls}`}>{SERVICE_LEVEL[s.level].word}</span>
                </div>
                {s.level !== "ok" || s.summary !== "Working" ? <p class="mt-1 text-sm text-muted break-words">{s.summary}</p> : null}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Claude" sub="Claude Sonnet writes listings and reviews them; Claude Haiku does the nightly checks and reply drafts.">
        <dl class="figures">
          <div>
            <dt>API key</dt>
            <dd>{u.apiKeySet ? "Set" : "Not set yet"}</dd>
          </div>
          <div>
            <dt>Today</dt>
            <dd>
              {usd(u.today.usd)} of {usd(u.dailyBudgetUsd)} · {plural(u.today.calls, "call")}
            </dd>
          </div>
          <div>
            <dt>This month</dt>
            <dd>
              {usd(u.month.usd)} · {plural(u.month.calls, "call")}
            </dd>
          </div>
        </dl>
        {u.byJob.length > 0 && (
          <>
            <h3 class="mt-5 mb-1 text-sm text-muted">This month, by job</h3>
            <dl class="figures">
              {u.byJob.map((j) => (
                <div key={j.job}>
                  <dt>{JOB_NAMES[j.job] ?? j.job}</dt>
                  <dd>
                    {usd(j.usd)} <span class="font-normal text-muted">· {plural(j.calls, "call")}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </Section>
    </div>
  );
}

export function Settings(props: ScreenProps) {
  const { me, reloadMe, onSignedOut, go } = props;
  const devices = useData<Device[]>("/push/devices", onSignedOut);
  const usage = useData<Usage>("/usage", onSignedOut);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const owner = me.user.role === "owner";
  const toasts = useToasts();
  const wide = useWide();
  const [section, open] = useSettingsSection();
  // On a wide screen a section is always showing (the first by default); on a phone the menu shows first.
  const shown: SectionId | null = section ?? (wide ? "account" : null);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const msg = await fn();
      if (msg) toasts.push("good", msg);
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else toasts.push("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enablePush = () =>
    run(async () => {
      if (!me.vapidPublicKey) return "Notifications aren't set up on the server yet.";
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser's site settings.");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(me.vapidPublicKey) }));
      await api("/push/subscribe", { body: { subscription: sub.toJSON() } });
      await devices.reload();
      return "This device will now get notifications.";
    });

  // One line under each menu entry saying how things stand.
  const claude = usage.data?.allowances?.find((a) => a.id === "claude");
  const lowCount = (usage.data?.allowances ?? []).filter((a) => a.level === "low" || a.level === "out").length;
  const downCount = (usage.data?.services ?? []).filter((s) => s.level === "down").length;
  const status: Record<SectionId, string> = {
    account: `${me.user.name}, ${owner ? "owner" : "manager"}`,
    notifications: permission === "granted" ? `On · ${plural(devices.data?.length ?? 0, "device")}` : permission === "denied" ? "Blocked here" : "Off on this device",
    connection: `${me.ebayEnv === "production" ? "Live" : "Sandbox"} · ${me.ebayConnected ? (me.ebayNeedsReconnect ? "reconnect needed" : me.ebayScopes === "read-only" ? "read-only" : "full permission") : "not connected"}`,
    style: "How Claude's reply drafts sound",
    usage: downCount ? `${plural(downCount, "service")} not working` : lowCount ? `${plural(lowCount, "allowance")} running low` : claude?.left != null ? `Claude ${usd(claude.left)} left` : "Claude spend and sold-data searches",
  };

  const body = (s: SectionId) =>
    s === "account" ? (
      <AccountSection me={me} onSignedOut={onSignedOut} run={run} busy={busy} />
    ) : s === "notifications" ? (
      <NotificationsSection me={me} run={run} busy={busy} devices={devices} permission={permission} enablePush={enablePush} />
    ) : s === "connection" ? (
      <ConnectionSection me={me} />
    ) : s === "style" ? (
      <StyleCard owner={owner} onSignedOut={onSignedOut} />
    ) : (
      <UsageSection me={me} usage={usage} run={run} busy={busy} />
    );

  const menu = (
    <LayoutGroup id="settings-menu">
      <motion.ul class="m-0 grid gap-2 p-0" variants={list} initial="hidden" animate="show">
        {SECTIONS.map((s) => {
          const active = wide && shown === s.id;
          return (
            <motion.li variants={item} class="list-none" key={s.id}>
              <button
                class={`card glow-hover relative flex w-full items-center gap-3 px-4 py-3 text-left ${active ? "border-accent" : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={() => open(s.id)}
              >
                {active && <motion.span layoutId="settings-active" class="nav-active" transition={SPRING} />}
                <span class="relative grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
                  <s.Icon size={18} />
                </span>
                <span class="relative min-w-0 flex-1">
                  <span class="block font-semibold">{s.title}</span>
                  <span class={`block truncate text-sm ${s.id === "usage" && lowCount ? "text-yellow" : "text-muted"}`}>{status[s.id]}</span>
                </span>
                <span class="relative -rotate-90 text-muted">
                  <Icons.chevron />
                </span>
              </button>
            </motion.li>
          );
        })}
      </motion.ul>
    </LayoutGroup>
  );

  const panel = shown && (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={shown} initial={{ opacity: 0, x: wide ? 0 : 24, y: wide ? 8 : 0 }} animate={{ opacity: 1, x: 0, y: 0 }} exit={{ opacity: 0, x: wide ? 0 : -16 }} transition={{ duration: 0.28, ease: EASE_OUT }}>
        {body(shown)}
      </motion.div>
    </AnimatePresence>
  );

  return (
    <>
      <div class="page-head">
        <div>
          {!wide && section ? (
            <button class="btn-link mb-1 inline-flex items-center gap-1.5 text-sm" onClick={() => history.back()}>
              <Icons.arrowLeft size={15} /> Settings
            </button>
          ) : null}
          <h1>{!wide && section ? SECTIONS.find((s) => s.id === section)!.title : "Settings"}</h1>
          <p>
            Signed in as {me.user.name}, {me.user.role}.
          </p>
        </div>
      </div>
      {/* On a phone the switch sits at the top of the main Settings page; a section opens on its own. */}
      {(wide || !section) && <ChangesCard me={me} reloadMe={reloadMe} run={run} busy={busy} go={go} />}
      {wide ? (
        <div class="grid grid-cols-[300px_1fr] items-start gap-5">
          <div class="sticky top-4">{menu}</div>
          <div class="min-w-0">{panel}</div>
        </div>
      ) : section ? (
        panel
      ) : (
        menu
      )}
      <AnimatePresence>
        <Toasts items={toasts.items} />
      </AnimatePresence>
    </>
  );
}
