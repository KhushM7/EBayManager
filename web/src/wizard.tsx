// "New listing" (docs/add-listing.md): the redesign's step-by-step wizard on the real drafts server
// (src/drafts.ts, src/newlisting.ts). Photos are the person's own: checked on the phone (photocheck.ts),
// shrunk and stripped of location before upload (listing/photos.ts), stored privately. Claude says what the
// item is and writes the listing only from the photos, the person's facts and sourced specs; the pricing
// engine prices it; submitting runs eBay's own check and files a create_listing label. Nothing reaches eBay
// until that label is approved, through the write gate. The draft is kept in the address (/new?draft=<id>),
// so the back button and a reload both work.

import { AnimatePresence, motion } from "framer-motion";
import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useRef, useState, type Dispatch, type StateUpdater } from "preact/hooks";
import { api, apiJob, SignedOut } from "./api";
import { CameraAssistant, Findings } from "./camera";
import { ago, money, plural } from "./format";
import { bitsToHex, CHECKLIST, hexToBits } from "./listing/checks";
import { blocking, issueCodes, processPhoto, type Processed } from "./listing/photos";
import { tidy } from "./listing/tidy";
import { PhotoAdjust } from "./listing/adjust";
import { ArrangePhotos } from "./listing/arrange";
import { gradePhoto, type PhotoGrade } from "./photocheck";
import type { ScreenProps } from "./screens";
import { EASE_OUT, Icons, SPRING, Toasts, useFocusFlow, useToasts } from "./ui";

// ---- The draft, as the server sends it (src/drafts.ts, view) ----

interface DraftPhoto {
  id: string;
  url: string;
  originalUrl: string;
  width: number;
  height: number;
  issues: string[];
  hash: string | null;
  edited?: { at: number; edits: string[]; issues?: string[] } | null;
  use_edited?: boolean;
}
interface Review {
  product: string;
  exact: boolean;
  brand: string;
  model: string;
  condition: string;
  visibleFacts: { fact: string; photo: number }[];
  flaws: { text: string; photo: number }[];
  missingShots: { shot: string; why: string }[];
  photoNotes: { photo: number; note: string }[];
  questions: { id: string; question: string; why: string }[];
}
interface Facts {
  condition: "new" | "opened" | "used" | "parts" | null;
  works: string | null;
  marks: string | null;
  included: string | null;
  missing: string | null;
  other: string | null;
  answers: Record<string, string>;
}
interface Aspect {
  name: string;
  required: boolean;
  values: string[];
  selectionOnly: boolean;
}
interface Draft {
  id: string;
  status: "open" | "submitted" | "published" | "abandoned";
  created_by: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  /** The person's name for the draft, in the drafts list only. */
  name?: string | null;
  /** A submitted draft's label: waiting, approved, applied, failed (with eBay's answer), rejected… */
  label?: { status: string; result: string | null } | null;
  photos: DraftPhoto[];
  missing: string[];
  review?: Review | null;
  facts?: Facts | null;
  specs?: { product: string | null; note?: string; aliases?: string[]; specs: { name: string; value: string; source: string; sourceTitle: string }[] } | null;
  categories?: { id: string; name: string; path: string }[];
  category?: { id: string; name: string; path: string } | null;
  aspects?: Aspect[];
  listing?: { title: string; description: string; specifics: { name: string; values: string[]; source: string; ref: string }[]; dropped: string[]; editedByK: boolean } | null;
  pricing?: { strategy: string; price: number | null; total: number | null; why: string; confidence: number; question?: string; reason?: string; options: { price: number; daysToSell: number }[] } | null;
  price?: { value: number; kind: "engine" | "own"; floor: number | null; bestOffer: boolean } | null;
  parcel?: { lengthCm: number; widthCm: number; heightCm: number; weightKg: number } | null;
  quotes?: { at?: number; quotes: { carrier: string; service: string; price: number }[]; error?: string } | null;
  postage?: { cost: number; carrier: string | null; service: string | null; collectionOffered: boolean; collectionOnly: boolean; postcode: string; mode?: "simple_delivery" | "courier"; size?: string | null; sizeBy?: "app" | "you" } | null;
  parcelPlan?: { at: number; item: { lengthCm: number | null; widthCm: number | null; heightCm: number | null; weightKg: number | null; source: "spec" | "estimate" | "unknown" }; packaging: string; confidence: "high" | "medium" | "low"; missing: string[]; by: "claude" | "you" } | null;
  proposal_id?: string | null;
  item_id?: string | null;
}

const MAX_PHOTOS = 24;
const ISSUE_WORD: Record<string, string> = {
  dark: "Dark",
  dim: "A bit dark",
  bright: "Washed out",
  glare: "Glare",
  uneven: "Uneven light",
  blur: "Blurry",
  soft: "Soft focus",
  flat: "Low contrast",
  small: "Item small",
  offcentre: "Off-centre",
  busy: "Busy background",
  tiny: "Too small",
  lowres: "Low resolution",
  crop: "Odd shape",
  duplicate: "Same as another",
};
const EDIT_WORD: Record<string, string> = { white_balance: "white balance", exposure: "exposure", background: "background to white", crop: "cropped", rotate: "rotated" };
const CONDITIONS = [
  ["new", "New", "Sealed, never opened"],
  ["opened", "Opened, never used", "The box has been opened, the item hasn't been used"],
  ["used", "Used", "Works, with the wear you describe below"],
  ["parts", "For parts or not working", "Doesn't work fully, sold as it is"],
] as const;

const STEPS = [
  { id: "photos", title: "Show it off", sub: "Take or upload real photos. Each one is checked as you add it, with exactly what to retake." },
  { id: "facts", title: "What is it?", sub: "Claude looks at the photos and says what it sees. Only you know the rest: nothing is assumed." },
  { id: "describe", title: "Tell its story", sub: "Claude writes the listing from your photos, your facts and published specs. You can edit every word." },
  { id: "price", title: "Set your price", sub: "From what the same item, in the same condition, actually sells for." },
  { id: "postage", title: "Postage", sub: "What the buyer pays to have it sent, or collection." },
  { id: "review", title: "Ready to list", sub: "eBay checks it first. Nothing is published until one of you approves it." },
] as const;

// ---- Helpers ----

const draftParam = () => new URLSearchParams(location.search).get("draft");
function openDraft(id: string | null) {
  history.pushState(null, "", id ? `/new?draft=${encodeURIComponent(id)}` : "/new");
  dispatchEvent(new PopStateEvent("popstate"));
  scrollTo({ top: 0 });
}
/** A photo's address, changing when its chosen version does (photos are cached privately for an hour). */
const photoSrc = (p: DraftPhoto) => `${p.url}?v=${p.use_edited && p.edited ? `e${p.edited.at}` : "o"}`;

/** Sends one prepared photo (or a tidied copy); the server checks it again and strips metadata a second time. */
async function sendJpeg(path: string, blob: Blob): Promise<Draft> {
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "image/jpeg", "X-EbayManager": "1" }, body: blob });
  if (res.status === 401) throw new SignedOut();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `Upload failed (${res.status})`);
  return data as Draft;
}
function upload(draftId: string, p: Processed): Promise<Draft> {
  const q = new URLSearchParams({ hash: bitsToHex(p.hash) });
  const codes = issueCodes(p.grade);
  if (codes.length) q.set("issues", codes.join(","));
  return sendJpeg(`/drafts/${draftId}/photos?${q}`, p.blob);
}

/** The furthest step this draft has reached, so reopening it lands where it was left. */
function reached(d: Draft): number {
  if (d.status !== "open") return 5;
  if (!d.photos.length) return 0;
  if (!d.review || !d.facts?.condition) return 1;
  if (!d.listing) return 2;
  if (!d.price) return 3;
  if (!d.postage) return 4;
  return 5;
}

/** What the drafts list calls a draft: the person's name for it, else the listing title, else their words. */
const draftName = (d: Draft) => d.name || d.listing?.title || d.title || "Untitled";
/** The photo-check findings for the version going on the listing. */
const photoIssues = (p: DraftPhoto) => (p.use_edited && p.edited?.issues ? p.edited.issues : p.issues);

const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

// ---- Small pieces of the look ----

/** Claude working: a shimmering skeleton with a sparkle, inside a slowly turning glowing border. */
function Working({ label, lines = 5 }: { label: string; lines?: number }) {
  return (
    <div class="glow-border rounded-2xl bg-surface p-5" role="status" aria-label={label}>
      <div class="mb-4 flex items-center gap-2 text-sm font-semibold text-accent">
        <motion.span animate={{ rotate: [0, 18, -12, 0], scale: [1, 1.2, 1] }} transition={{ duration: 1.6, repeat: Infinity }}>
          <Icons.sparkles size={18} />
        </motion.span>
        {label}
      </div>
      {[92, 100, 84, 96, 60].slice(0, lines).map((w, i) => (
        <motion.div key={i} class="skeleton mb-2.5 h-3.5" style={{ width: `${w}%` }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.12 }} />
      ))}
    </div>
  );
}

/** A big tappable card that starts a Claude or engine step. */
function StartCard({ title, sub, onClick, disabled }: { title: string; sub: string; onClick: () => void; disabled?: boolean }) {
  return (
    <motion.button whileTap={{ scale: 0.97 }} whileHover={{ y: -2 }} class="glow-border flex w-full items-center gap-4 rounded-2xl bg-surface p-5 text-left" onClick={onClick} disabled={disabled}>
      <span class="grid size-12 flex-none place-items-center rounded-xl bg-accent-soft text-accent">
        <Icons.sparkles size={22} />
      </span>
      <span>
        <span class="block font-semibold">{title}</span>
        <span class="text-sm text-muted">{sub}</span>
      </span>
    </motion.button>
  );
}

function Toggle({ label, sub, checked, disabled, onChange }: { label: string; sub?: string; checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <label class="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
      <span>
        <span class="block font-semibold">{label}</span>
        {sub && <span class="text-sm text-muted">{sub}</span>}
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="grid gap-1.5 text-sm font-semibold text-ink-2">
      {label}
      {children}
      {hint && <span class="text-xs font-normal text-muted">{hint}</span>}
    </label>
  );
}

const Chip = ({ tone = "muted", children }: { tone?: "muted" | "good" | "warn" | "accent"; children: ComponentChildren }) => (
  <span class={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone === "good" ? "bg-green-soft text-green" : tone === "warn" ? "bg-yellow-soft text-yellow" : tone === "accent" ? "bg-accent-soft text-accent" : "bg-surface-3 text-ink-2"}`}>{children}</span>
);

// ---- The screen ----

export function NewListing(props: ScreenProps) {
  const [id, setId] = useState(draftParam());
  useEffect(() => {
    const on = () => setId(draftParam());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return id ? <Wizard key={id} {...props} id={id} /> : <Drafts {...props} />;
}

function DraftCard({ d, onChanged, onError }: { d: Draft; onChanged?: () => void; onError?: (e: unknown) => void }) {
  const status =
    d.status === "submitted"
      ? d.label?.status === "failed"
        ? "eBay refused it: open to send again"
        : "Waiting for approval"
      : d.status === "published"
        ? `Listed, item ${d.item_id}`
        : `Step ${reached(d) + 1} of ${STEPS.length}`;
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState(d.name ?? "");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (mode === "rename") nameRef.current?.select();
  }, [mode]);
  const editable = d.status === "open" && onChanged;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setMode("view");
      onChanged?.();
    } catch (e) {
      onError?.(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.li class="card list-none" layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ ease: EASE_OUT }}>
      <a class="flex items-center gap-4 no-underline" href={`/new?draft=${d.id}`} onClick={(e) => (e.preventDefault(), openDraft(d.id))}>
        {d.photos[0] ? <img src={photoSrc(d.photos[0])} alt="" loading="lazy" class="size-16 flex-none rounded-xl object-cover" /> : <span class="grid size-16 flex-none place-items-center rounded-xl bg-surface-3 text-muted"><Icons.camera size={22} /></span>}
        <span class="min-w-0 flex-1">
          <span class="block truncate font-semibold text-ink">{draftName(d)}</span>
          <span class="text-sm text-muted">
            {status} · {plural(d.photos.length, "photo")} · {d.created_by} · {ago(d.updated_at)}
          </span>
        </span>
        <Icons.arrowRight size={16} />
      </a>
      {editable && mode === "view" && (
        <div class="mt-3 flex gap-4 border-t border-line pt-2 text-sm">
          <button class="btn-link" onClick={() => (setName(d.name ?? ""), setMode("rename"))}>
            Rename
          </button>
          <button class="btn-link text-red" onClick={() => setMode("delete")}>
            Delete
          </button>
        </div>
      )}
      {editable && mode === "rename" && (
        <form class="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3" onSubmit={(e) => (e.preventDefault(), act(() => api(`/drafts/${d.id}`, { body: { name } })))}>
          <label class="grid min-w-0 flex-1 gap-1 text-sm font-semibold text-ink-2">
            Draft name
            <input ref={nameRef} value={name} maxLength={80} placeholder={draftName(d)} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          <button class="btn btn-primary" disabled={busy}>
            Save
          </button>
          <button type="button" class="btn btn-text" disabled={busy} onClick={() => setMode("view")}>
            Cancel
          </button>
          <p class="w-full text-xs text-muted">Only for this list. It doesn't change the listing title.</p>
        </form>
      )}
      {editable && mode === "delete" && (
        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <p class="w-full text-sm">Delete this draft and its {plural(d.photos.length, "photo")}? This can't be undone.</p>
          <button class="btn btn-danger" disabled={busy} onClick={() => act(() => api(`/drafts/${d.id}/delete`, { body: {} }))}>
            {busy ? "Deleting…" : "Delete draft"}
          </button>
          <button class="btn btn-text" disabled={busy} onClick={() => setMode("view")}>
            Cancel
          </button>
        </div>
      )}
    </motion.li>
  );
}

function Drafts({ onSignedOut }: ScreenProps) {
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [sent, setSent] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const toasts = useToasts();
  const fail = (e: unknown) => (e instanceof SignedOut ? onSignedOut() : toasts.push("bad", (e as Error).message, 5200));
  const reload = () => api<Draft[]>("/drafts").then(setRows).catch(fail);
  useEffect(() => {
    reload();
    api<Draft[]>("/drafts/submitted").then(setSent).catch(() => {});
  }, []);
  const create = async () => {
    setBusy(true);
    try {
      openDraft((await api<Draft>("/drafts", { body: {} })).id);
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  return (
    <div class="pb-28">
      <h1 class="text-3xl sm:text-4xl">Sell something</h1>
      <p class="mt-3 max-w-xl text-muted">Start with photos. The app checks each one as you take it, then helps with the facts, the listing, price and postage. Nothing is listed until one of you approves it.</p>
      <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary mt-6" disabled={busy} onClick={create}>
        <Icons.plus size={16} /> New listing
      </motion.button>
      {rows && rows.length > 0 && (
        <section class="mt-10">
          <h2 class="mb-3 text-lg">Drafts</h2>
          <ul class="grid gap-3 p-0">
            <AnimatePresence>{rows.map((d) => <DraftCard key={d.id} d={d} onChanged={reload} onError={fail} />)}</AnimatePresence>
          </ul>
          <p class="mt-2 text-sm text-muted">Drafts save as you go. Ones nobody touches for 30 days are deleted, with their photos.</p>
        </section>
      )}
      {sent.length > 0 && (
        <section class="mt-10">
          <h2 class="mb-3 text-lg">Sent and listed</h2>
          <ul class="grid gap-3 p-0">{sent.map((d) => <DraftCard key={d.id} d={d} />)}</ul>
        </section>
      )}
      <AnimatePresence>
        <Toasts items={toasts.items} />
      </AnimatePresence>
    </div>
  );
}

interface Pending {
  key: string;
  file: File;
  url: string;
  processed?: Processed;
  state: "checking" | "review" | "uploading" | "error";
  error?: string;
}

const emptyFacts = (): Facts => ({ condition: null, works: null, marks: null, included: null, missing: null, other: null, answers: {} });
const sameFacts = (a: Facts, b: Facts) => JSON.stringify(a) === JSON.stringify(b);

function Wizard({ id, onSignedOut, onChanged, go }: ScreenProps & { id: string }) {
  useFocusFlow();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [grades, setGrades] = useState<Record<string, PhotoGrade>>({});
  const [facts, setFacts] = useState<Facts>(emptyFacts());
  const [postage, setPostage] = useState<PostageForm | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [missingFor404, setMissing] = useState(false);
  const toasts = useToasts();
  const camRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;

  const fail = (e: unknown) => {
    if (e instanceof SignedOut) return onSignedOut();
    toasts.push("bad", (e as Error).message || "Something went wrong", 6000);
  };
  const take = (d: Draft) => {
    setDraft(d);
    return d;
  };
  const load = () => api<Draft>(`/drafts/${id}`).then(take);

  useEffect(() => {
    load()
      .then((d) => {
        setStep(reached(d));
        setFacts(d.facts ?? emptyFacts());
      })
      .catch((e) => (/not found/i.test((e as Error).message) ? setMissing(true) : fail(e)));
  }, [id]);

  /** Runs one server step, then shows the updated draft. */
  const run = async (name: string, fn: () => Promise<Draft | { note?: string } | unknown>, done?: string) => {
    setBusy(name);
    try {
      const out: any = await fn();
      if (out && typeof out === "object" && "photos" in out) take(out as Draft);
      else await load();
      if (out?.note) toasts.push("good", out.note, 6000);
      else if (done) toasts.push("good", done, 3200);
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const post = (path: string, body: unknown = {}) => api<Draft>(`/drafts/${id}${path}`, { body });
  const job = (path: string) => apiJob<Draft>(`/drafts/${id}${path}`, {}, () => toasts.push("info", "Working on it in the background. It's safe to leave; you'll get a notification.", 5000));

  // ---- Photos ----
  const update = (key: string, patch: Partial<Pending>) => setPending((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const drop = (key: string) =>
    setPending((ps) => {
      const p = ps.find((x) => x.key === key);
      if (p) URL.revokeObjectURL(p.url);
      return ps.filter((x) => x.key !== key);
    });
  const send = async (p: Pending) => {
    update(p.key, { state: "uploading" });
    try {
      const before = new Set((draftRef.current?.photos ?? []).map((x) => x.id));
      const d = take(await upload(id, p.processed!));
      const added = d.photos.find((x) => !before.has(x.id));
      if (added) setGrades((g) => ({ ...g, [added.id]: p.processed!.grade }));
      drop(p.key);
    } catch (e) {
      if (e instanceof SignedOut) return onSignedOut();
      update(p.key, { state: "error", error: (e as Error).message });
    }
  };
  // Each new photo is checked on the phone; one without a serious problem uploads at once, one with a serious
  // problem (dark, blurry, too small, the same shot twice) waits for Retake, Keep anyway or Discard.
  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = [...list].filter((f) => f.type.startsWith("image/"));
    const room = MAX_PHOTOS - (draftRef.current?.photos.length ?? 0) - pending.length;
    const chosen = files.slice(0, Math.max(0, room));
    if (chosen.length < files.length) toasts.push("warn", `eBay allows ${MAX_PHOTOS} photos: only the first ${chosen.length} were added.`, 5000);
    const items: Pending[] = chosen.map((file, i) => ({ key: `${Date.now()}-${i}`, file, url: URL.createObjectURL(file), state: "checking" }));
    setPending((ps) => [...ps, ...items]);
    const seen = (draftRef.current?.photos ?? []).map((p) => p.hash).filter((h): h is string => Boolean(h)).map(hexToBits);
    for (const item of items) {
      const started = Date.now();
      try {
        const processed = await processPhoto(item.file, seen);
        seen.push(processed.hash);
        // Hold the scan on screen briefly so the sweep reads as a check, not a flicker.
        await new Promise((r) => setTimeout(r, Math.max(0, 1100 - (Date.now() - started))));
        if (blocking(processed.grade).length) update(item.key, { processed, state: "review" });
        else await send({ ...item, processed });
      } catch (e) {
        update(item.key, { state: "error", error: (e as Error).message || "That file couldn't be read as a photo." });
      }
    }
  };
  const order = async (photoId: string, by: number) => {
    const ids = draft!.photos.map((p) => p.id);
    const i = ids.indexOf(photoId);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await run("order", () => post("/order", { order: ids }));
  };

  if (missingFor404)
    return (
      <div class="grid max-w-md gap-4 py-10">
        <h1>That draft has gone</h1>
        <p class="text-muted">It was deleted, or left untouched for 30 days.</p>
        <button class="btn btn-secondary w-fit" onClick={() => openDraft(null)}>
          <Icons.arrowLeft size={16} /> All drafts
        </button>
      </div>
    );
  if (!draft)
    return (
      <div class="grid gap-4" aria-busy="true">
        <div class="skeleton h-1.5 w-full" />
        <div class="skeleton h-10 w-64" />
        <div class="skeleton h-48 w-full" />
      </div>
    );

  const open = draft.status === "open";
  const furthest = reached(draft);
  const s = STEPS[step];
  const go2 = (to: number) => (setDir(to > step ? 1 : -1), setStep(Math.max(0, Math.min(STEPS.length - 1, to))), scrollTo({ top: 0, behavior: "smooth" }));

  // Leaving a step saves what was typed on it (facts and postage); the others save as they go.
  const next = async () => {
    if (s.id === "facts" && open && (!draft.facts || !sameFacts(facts, draft.facts))) {
      if (!(await run("facts", () => post("/facts", facts), "Facts saved"))) return;
    }
    if (s.id === "postage" && open && postage) {
      if (!(await run("postage", () => post("/postage", postageBody(postage)), "Postage saved"))) return;
    }
    go2(step + 1);
  };
  const canNext = (() => {
    if (busy) return false;
    if (!open) return step < STEPS.length - 1;
    switch (s.id) {
      case "photos":
        return draft.photos.length > 0 && pending.every((p) => p.state === "error");
      case "facts":
        return Boolean(draft.review) && Boolean(facts.condition);
      case "describe":
        return Boolean(draft.listing);
      case "price":
        return Boolean(draft.price);
      case "postage":
        return postage ? postageReady(postage) : Boolean(draft.postage);
      default:
        return false;
    }
  })();

  const submit = () =>
    run("submit", async () => {
      const out = await post("/submit");
      onChanged();
      return out;
    });

  return (
    <div class="pb-28">
      <div class="mb-4 flex items-center justify-between gap-3">
        <button class="btn-link inline-flex items-center gap-1 text-sm" disabled={busy !== null} onClick={() => ((document.activeElement as HTMLElement | null)?.blur(), setTimeout(() => openDraft(null), 0))}>
          <Icons.arrowLeft size={14} /> {open ? "Save and close" : "All drafts"}
        </button>
        <span class="text-sm text-muted">
          {draft.status === "submitted" ? "Waiting for approval" : draft.status === "published" ? `Listed, item ${draft.item_id}` : `Started by ${draft.created_by} ${ago(draft.created_at)}`}
        </span>
      </div>

      {/* Progress: one segment per step; reached steps can be tapped */}
      <div class="mb-6 flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((x, i) => (
          <button
            key={x.id}
            class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3 p-0"
            disabled={i > furthest || busy !== null}
            onClick={() => go2(i)}
            aria-label={`Step ${i + 1}: ${x.title}`}
            aria-current={i === step ? "step" : undefined}
          >
            <motion.div class="h-full rounded-full bg-accent" initial={false} animate={{ width: i < step ? "100%" : i === step ? "50%" : i <= furthest ? "15%" : "0%" }} transition={{ duration: 0.5, ease: EASE_OUT }} style={{ boxShadow: "0 0 12px var(--glow)" }} />
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait" custom={dir}>
        <motion.div key={s.id} custom={dir} initial={{ opacity: 0, x: dir * 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: dir * -40 }} transition={{ duration: 0.38, ease: EASE_OUT }} class="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div>
            <p class="text-sm font-semibold text-accent">
              Step {step + 1} of {STEPS.length}
            </p>
            <h1 class="mt-1 text-3xl sm:text-4xl">{s.title}</h1>
            <p class="mt-3 max-w-md text-muted">{s.sub}</p>
            {s.id === "photos" && open && <ItsName draft={draft} onSave={(title) => run("title", () => post("", { title }))} />}
            {s.id === "photos" && <PhotoTips draft={draft} grades={grades} />}
            {s.id === "facts" && draft.review && <ReviewSummary draft={draft} />}
          </div>

          <div>
            {s.id === "photos" && (
              <PhotosStep
                draft={draft}
                open={open}
                pending={pending}
                grades={grades}
                busy={busy}
                camRef={camRef}
                fileRef={fileRef}
                onAdd={add}
                onKeep={send}
                onDrop={drop}
                onMove={order}
                onArrange={async (ids) => {
                  if (!(await run("order", () => post("/order", { order: ids }), "Order saved"))) throw new Error("Couldn't save the order. Try again.");
                }}
                onGraded={(pid, g) => setGrades((cur) => ({ ...cur, [pid]: g }))}
                onRemove={(pid) => run("remove", () => post(`/photos/${pid}/remove`))}
                onChanged={take}
                onError={fail}
              />
            )}
            {s.id === "facts" && (
              <FactsStep
                draft={draft}
                open={open}
                busy={busy}
                facts={facts}
                setFacts={setFacts}
                onReview={() =>
                  run("review", async () => {
                    // The condition first: it changes what the photo check may suggest (never unpacking a new item).
                    if (!draft.facts || !sameFacts(facts, draft.facts)) await post("/facts", facts);
                    return job("/review");
                  })
                }
              />
            )}
            {s.id === "describe" && (
              <ListingStep
                draft={draft}
                open={open}
                busy={busy}
                onCategory={(categoryId) => run("category", () => post("/category", { categoryId }))}
                onCompose={() => run("compose", () => job("/compose"))}
                onEdit={(b) => run("listing", () => post("/listing", b))}
              />
            )}
            {s.id === "price" && <PriceStep draft={draft} open={open} busy={busy} onCheck={() => run("price-check", () => job("/price-check"))} onChoose={(b) => run("price", () => post("/price", b), "Price set")} />}
            {s.id === "postage" && <PostageStep draft={draft} open={open} busy={busy} form={postage} setForm={setPostage} onQuote={(p) => run("quotes", () => post("/quotes", p))} onPlan={() => run("postage-plan", () => job("/postage-plan"))} />}
            {s.id === "review" && (
              <ReviewStep
                draft={draft}
                busy={busy}
                confirmDelete={confirmDelete}
                onSubmit={submit}
                onReopen={() => run("reopen", () => post("/reopen"), "Back to editing")}
                onRetry={() =>
                  run("submit", async () => {
                    // The same draft, unchanged: back to editing, then eBay's check and a fresh label in the Inbox.
                    await post("/reopen");
                    const out = await post("/submit");
                    onChanged();
                    return out;
                  })
                }
                onDelete={() => (confirmDelete ? run("delete", async () => (await post("/delete"), openDraft(null), {})) : setConfirmDelete(true))}
                onInbox={() => go("/")}
              />
            )}
          </div>
        </motion.div>
      </AnimatePresence>

      {/* The step bar: always reachable with a thumb */}
      <div class="fixed inset-x-0 z-40 px-4 min-[861px]:pl-[calc(var(--sidebar)+16px)]" style={{ bottom: "calc(var(--tabbar) + max(16px, env(safe-area-inset-bottom)))" }}>
        <div class="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-2xl border border-line-strong bg-glass p-2 shadow-float backdrop-blur-xl">
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-text" disabled={step === 0 || busy !== null} onClick={() => go2(step - 1)}>
            <Icons.arrowLeft size={16} /> Back
          </motion.button>
          <span class="truncate text-sm text-muted">{busy ? "Working…" : s.title}</span>
          {step < STEPS.length - 1 ? (
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={!canNext} onClick={next}>
              Next <Icons.arrowRight size={16} />
            </motion.button>
          ) : open ? (
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-approve" disabled={busy !== null || draft.missing.length > 0} onClick={submit}>
              {busy === "submit" ? "eBay is checking…" : "Send for approval"}
            </motion.button>
          ) : (
            <span />
          )}
        </div>
      </div>
      <AnimatePresence>
        <Toasts items={toasts.items} />
      </AnimatePresence>
    </div>
  );
}

// ---- Step 1: photos ----

/** What it is in K's words: optional, shown to Claude with the photos, and eBay's category search falls back on it. */
function ItsName({ draft, onSave }: { draft: Draft; onSave: (title: string) => void }) {
  const [v, setV] = useState(draft.title ?? "");
  return (
    <div class="mt-6">
      <Field label="What is it, in your words?" hint="Optional: the photos come first. Claude sees this with them.">
        <input value={v} maxLength={120} placeholder="e.g. Dyson vacuum, needs a new hose" onInput={(e) => setV(e.currentTarget.value)} onBlur={(e) => (draft.title ?? "") !== e.currentTarget.value.trim() && onSave(e.currentTarget.value)} />
      </Field>
    </div>
  );
}

function PhotoTips({ draft, grades }: { draft: Draft; grades: Record<string, PhotoGrade> }) {
  const graded = draft.photos.map((p) => grades[p.id]).filter(Boolean);
  const avg = graded.length ? Math.round(graded.reduce((n, g) => n + g.score, 0) / graded.length) : 0;
  const icons = [Icons.sun, Icons.box, Icons.focus, Icons.camera, Icons.grid, Icons.eye];
  return (
    <>
      <details class="mt-6" open={draft.photos.length === 0}>
        <summary class="cursor-pointer text-sm font-semibold text-ink-2">Before you start</summary>
        <ul class="mt-3 grid gap-2.5 p-0 text-sm text-ink-2">
          {CHECKLIST.map((c, i) => {
            const I = icons[i % icons.length];
            return (
              <li key={c.title} class="flex list-none items-start gap-3">
                <span class="grid size-8 flex-none place-items-center rounded-lg bg-surface-2 text-muted">
                  <I size={16} />
                </span>
                <span>
                  <strong>{c.title}.</strong> {c.text}
                </span>
              </li>
            );
          })}
        </ul>
      </details>
      {graded.length > 0 && (
        <div class="card mt-6 flex items-center gap-4">
          <span class="text-3xl font-bold tabular-nums" style={{ color: avg >= 85 ? "var(--green)" : avg >= 65 ? "var(--blue)" : "var(--yellow)" }}>
            {avg}
          </span>
          <span class="text-sm text-muted">Average score of the {plural(graded.length, "photo")} added on this visit. Aim for 85 or more.</span>
        </div>
      )}
      <p class="mt-6 text-sm text-muted">Photos are shrunk and their location data removed on this device before upload. Only the people on this account can see them.</p>
    </>
  );
}

function PhotosStep(props: {
  draft: Draft;
  open: boolean;
  pending: Pending[];
  grades: Record<string, PhotoGrade>;
  busy: string | null;
  camRef: RefObject<HTMLInputElement>;
  fileRef: RefObject<HTMLInputElement>;
  onAdd: (f: FileList | null) => void;
  onKeep: (p: Pending) => void;
  onDrop: (key: string) => void;
  onMove: (photoId: string, by: number) => void;
  onArrange: (order: string[]) => Promise<void>;
  onGraded: (photoId: string, grade: PhotoGrade) => void;
  onRemove: (photoId: string) => void;
  onChanged: (d: Draft) => void;
  onError: (e: unknown) => void;
}) {
  const { draft, open, pending, camRef, fileRef } = props;
  const [arranging, setArranging] = useState(false);
  const count = draft.photos.length;
  const full = count + pending.length >= MAX_PHOTOS;
  const inputs = (
    <>
      <input ref={fileRef} type="file" accept="image/*" multiple class="hidden" onChange={(e) => (props.onAdd(e.currentTarget.files), (e.currentTarget.value = ""))} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" class="hidden" onChange={(e) => (props.onAdd(e.currentTarget.files), (e.currentTarget.value = ""))} />
    </>
  );
  if (count === 0 && pending.length === 0)
    return (
      <>
        {inputs}
        <motion.div
          class="flex flex-col items-center justify-center gap-4 rounded-3xl border-2 border-dashed border-line-strong bg-surface/60 px-6 py-16 text-center"
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={(e: DragEvent) => (e.preventDefault(), props.onAdd(e.dataTransfer?.files ?? null))}
          whileHover={{ borderColor: "var(--accent)" }}
        >
          <motion.span class="grid size-16 place-items-center rounded-2xl bg-accent-soft text-accent" animate={{ y: [0, -6, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}>
            <Icons.camera size={28} />
          </motion.span>
          <div>
            <p class="font-semibold">Add your first photo</p>
            <p class="text-sm text-muted">Drag photos here, or use your camera</p>
          </div>
          {open && (
            <div class="flex flex-wrap justify-center gap-2">
              <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" onClick={() => camRef.current?.click()}>
                <Icons.camera size={16} /> Take a photo
              </motion.button>
              <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" onClick={() => fileRef.current?.click()}>
                <Icons.upload size={16} /> Upload
              </motion.button>
            </div>
          )}
        </motion.div>
      </>
    );
  return (
    <>
      {inputs}
      {open && count >= 2 && (
        <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary mb-4" disabled={props.busy !== null} onClick={() => setArranging(true)}>
          <Icons.grid size={16} /> Arrange photos
        </motion.button>
      )}
      <div class="grid gap-5 sm:grid-cols-2">
        <AnimatePresence>
          {pending.map((p) => (
            <motion.div key={p.key} layout initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.35, ease: EASE_OUT }} aria-live="polite">
              <CameraAssistant url={p.url} grade={p.processed?.grade ?? null} scanning={p.state === "checking" || p.state === "uploading"} label="New photo" onRemove={p.state === "uploading" ? undefined : () => props.onDrop(p.key)} />
              {p.state === "uploading" && <p class="mt-2 text-sm text-muted">Uploading…</p>}
              {p.state === "error" && <p class="mt-2 rounded-xl bg-red-soft px-3 py-2 text-sm text-red">{p.error}</p>}
              {p.state === "review" && p.processed && (
                <>
                  <Findings grade={p.processed.grade} />
                  <div class="mt-3 flex flex-wrap gap-2">
                    <button class="btn btn-primary" onClick={() => (props.onDrop(p.key), camRef.current?.click())}>
                      <Icons.camera size={16} /> Retake
                    </button>
                    <button class="btn btn-secondary" onClick={() => props.onKeep(p)}>
                      Keep anyway
                    </button>
                    <button class="btn btn-text" onClick={() => props.onDrop(p.key)}>
                      Discard
                    </button>
                  </div>
                </>
              )}
            </motion.div>
          ))}
          {draft.photos.map((ph, i) => (
            <motion.div key={ph.id} layout initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.35, ease: EASE_OUT }}>
              <PhotoCard ph={ph} i={i} last={i === count - 1} open={open} busy={props.busy} draftId={draft.id} grade={props.grades[ph.id] ?? null} onMove={(by) => props.onMove(ph.id, by)} onGraded={(g) => props.onGraded(ph.id, g)} onRemove={() => props.onRemove(ph.id)} onChanged={props.onChanged} onError={props.onError} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {arranging && (
        <ArrangePhotos
          photos={draft.photos.map((ph) => ({ id: ph.id, src: photoSrc(ph) }))}
          onCancel={() => setArranging(false)}
          onDone={async (ids) => {
            await props.onArrange(ids);
            setArranging(false);
          }}
        />
      )}
      {open && (
        <div class="mt-5 flex flex-wrap items-center gap-2">
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" disabled={full} onClick={() => camRef.current?.click()}>
            <Icons.camera size={16} /> Take another
          </motion.button>
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-text" disabled={full} onClick={() => fileRef.current?.click()}>
            <Icons.upload size={16} /> Upload more
          </motion.button>
          <span class="text-sm text-muted">
            {count} of {MAX_PHOTOS}
          </span>
        </div>
      )}
    </>
  );
}

/** One uploaded photo: order, remove, and the background tidy-up (ordinary edits only; the original is kept). */
function PhotoCard(props: {
  ph: DraftPhoto;
  i: number;
  last: boolean;
  open: boolean;
  busy: string | null;
  draftId: string;
  grade: PhotoGrade | null;
  onMove: (by: number) => void;
  onGraded: (grade: PhotoGrade) => void;
  onRemove: () => void;
  onChanged: (d: Draft) => void;
  onError: (e: unknown) => void;
}) {
  const { ph, i, last, open, draftId } = props;
  const [preview, setPreview] = useState<{ url: string; blob: Blob; edits: string[] } | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  /** Edits already on the version in use, so a second edit (a crop after a tidy) keeps both in the record. */
  const priorEdits = ph.use_edited && ph.edited ? ph.edited.edits : [];
  const saveEdited = async (blob: Blob, edits: string[], grade?: PhotoGrade) => {
    const q = new URLSearchParams({ edits: [...new Set([...priorEdits, ...edits])].join(",") });
    if (grade) q.set("issues", issueCodes(grade).join(","));
    props.onChanged(await sendJpeg(`/drafts/${draftId}/photos/${ph.id}/edited?${q}`, blob));
    if (grade) props.onGraded(grade);
  };
  const [refused, setRefused] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const runTidy = async () => {
    setWorking(true);
    setRefused(null);
    try {
      // Tidies the version in use (which may already be cropped).
      const img = new Image();
      img.src = photoSrc(ph);
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const r = tidy({ data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height });
      if ("refused" in r) return setRefused(r.refused);
      const out = document.createElement("canvas");
      out.width = r.image.w;
      out.height = r.image.h;
      out.getContext("2d")!.putImageData(new ImageData(r.image.data as Uint8ClampedArray<ArrayBuffer>, r.image.w, r.image.h), 0, 0);
      const blob = await new Promise<Blob>((ok, no) => out.toBlob((b) => (b ? ok(b) : no(new Error("Couldn't prepare the tidied photo"))), "image/jpeg", 0.9));
      setPreview({ url: out.toDataURL("image/jpeg", 0.6), blob, edits: r.edits });
    } catch (e) {
      props.onError(e);
    } finally {
      setWorking(false);
    }
  };
  const useTidied = async () => {
    if (!preview) return;
    setWorking(true);
    try {
      await saveEdited(preview.blob, preview.edits, await gradePhoto(preview.blob).catch(() => undefined));
      setPreview(null);
    } catch (e) {
      props.onError(e);
    } finally {
      setWorking(false);
    }
  };
  const choose = async (edited: boolean) => {
    try {
      props.onChanged(await api<Draft>(`/drafts/${draftId}/photos/${ph.id}/use`, { body: { edited } }));
    } catch (e) {
      props.onError(e);
    }
  };
  const disabled = props.busy !== null || working;

  return (
    <>
      <CameraAssistant url={photoSrc(ph)} grade={props.grade} scanning={false} label={`Photo ${i + 1}`} onRemove={open ? props.onRemove : undefined} />
      <div class="mt-2 flex flex-wrap gap-1.5">
        {i === 0 && <Chip tone="accent">Main photo</Chip>}
        {ph.use_edited && ph.edited && <Chip tone="good">Edited: {ph.edited.edits.map((e) => EDIT_WORD[e] ?? e).join(", ")}</Chip>}
        {!props.grade && photoIssues(ph).map((code) => <Chip key={code} tone="warn">{ISSUE_WORD[code] ?? code}</Chip>)}
      </div>
      {props.grade && props.grade.findings.some((f) => f.tone !== "good") && <Findings grade={props.grade} />}
      {preview && (
        <div class="card mt-3">
          <p class="text-sm">Tidied: {preview.edits.map((e) => EDIT_WORD[e] ?? e).join(", ")}. Nothing on the item itself was changed.</p>
          <img src={preview.url} alt="Tidied version" class="mt-3 w-full rounded-xl" />
          <div class="mt-3 flex flex-wrap gap-2">
            <button class="btn btn-primary" disabled={working} onClick={useTidied}>
              Use tidied
            </button>
            <button class="btn btn-text" onClick={() => setPreview(null)}>
              Keep original
            </button>
          </div>
        </div>
      )}
      {refused && <p class="mt-2 rounded-xl bg-yellow-soft px-3 py-2 text-sm text-yellow">{refused}</p>}
      {open && (
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <button class="btn-link" disabled={i === 0 || disabled} onClick={() => props.onMove(-1)} aria-label={`Move photo ${i + 1} earlier`}>
            ← Earlier
          </button>
          <button class="btn-link" disabled={last || disabled} onClick={() => props.onMove(1)} aria-label={`Move photo ${i + 1} later`}>
            Later →
          </button>
          <button class="btn-link" disabled={disabled} onClick={() => setAdjusting(true)}>
            Adjust (rotate, crop, centre)
          </button>
          {!(ph.use_edited && ph.edited?.edits.includes("background")) && (
            <button class="btn-link" disabled={disabled} onClick={runTidy}>
              {working ? "Tidying…" : "Tidy background"}
            </button>
          )}
          {ph.edited && (
            <button class="btn-link" disabled={disabled} onClick={() => choose(!ph.use_edited)}>
              {ph.use_edited ? "Use original" : "Use edited"}
            </button>
          )}
        </div>
      )}
      {adjusting && (
        <PhotoAdjust
          src={photoSrc(ph)}
          onCancel={() => setAdjusting(false)}
          onSave={async (blob, grade, edits) => {
            await saveEdited(blob, edits, grade);
            setAdjusting(false);
          }}
        />
      )}
    </>
  );
}

// ---- Step 2: Claude's photo check and K's facts ----

function ReviewSummary({ draft }: { draft: Draft }) {
  const r = draft.review!;
  return (
    <div class="card mt-6 grid gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <strong>{r.product}</strong>
        {r.exact ? <Chip tone="good">Exact model</Chip> : <Chip tone="warn">Model not certain</Chip>}
      </div>
      {r.missingShots.length > 0 && (
        <div>
          <p class="kind">Shots to add</p>
          <ul class="m-0 grid gap-1 pl-5 text-sm">
            {r.missingShots.map((x) => (
              <li key={x.shot}>
                <strong>{x.shot}.</strong> {x.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.photoNotes.length > 0 && (
        <ul class="m-0 grid gap-1 pl-5 text-sm text-muted">
          {r.photoNotes.map((n, i) => (
            <li key={i}>
              Photo {n.photo}: {n.note}
            </li>
          ))}
        </ul>
      )}
      <details class="text-sm">
        <summary class="cursor-pointer">What the photos show ({r.visibleFacts.length + r.flaws.length})</summary>
        <ul class="mt-2 grid gap-1 pl-5">
          {r.visibleFacts.map((f, i) => (
            <li key={`f${i}`}>
              {f.fact} <span class="text-muted">(photo {f.photo})</span>
            </li>
          ))}
          {r.flaws.map((f, i) => (
            <li key={`x${i}`}>
              Flaw: {f.text} <span class="text-muted">(photo {f.photo})</span>
            </li>
          ))}
        </ul>
      </details>
      {draft.specs && draft.specs.specs.length === 0 && draft.specs.note && <p class="text-sm text-muted">Published specs: {draft.specs.note}</p>}
      {draft.specs?.aliases && draft.specs.aliases.length > 0 && <p class="text-sm text-muted">Also sold as: {draft.specs.aliases.join(", ")}</p>}
      {draft.specs && draft.specs.specs.length > 0 && (
        <details class="text-sm">
          <summary class="cursor-pointer">
            {plural(draft.specs.specs.length, "published spec")} for the {draft.specs.product}
          </summary>
          <ul class="mt-2 grid gap-1 pl-5">
            {draft.specs.specs.map((x) => (
              <li key={x.name}>
                {x.name}: <strong>{x.value}</strong>{" "}
                <a href={x.source} target="_blank" rel="noopener noreferrer">
                  {x.sourceTitle || "source"}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function FactsStep({ draft, open, busy, facts: f, setFacts: setAll, onReview }: { draft: Draft; open: boolean; busy: string | null; facts: Facts; setFacts: Dispatch<StateUpdater<Facts>>; onReview: () => void }) {
  const r = draft.review;
  // Merged into the latest state, so quick successive edits (autofill, fast typing) never undo each other.
  const setFacts = (patch: Partial<Facts>) => setAll((cur) => ({ ...cur, ...patch, answers: { ...cur.answers, ...patch.answers } }));
  const text = (k: "works" | "marks" | "included" | "missing" | "other", label: string, placeholder = "") => (
    <Field label={label}>
      <textarea rows={2} disabled={!open} placeholder={placeholder} value={(f[k] as string) ?? ""} onInput={(e) => setFacts({ [k]: e.currentTarget.value })} />
    </Field>
  );
  const unused = f.condition === "new" || f.condition === "opened";
  const conditionPicker = (
            <fieldset class="m-0 grid gap-2 border-0 p-0">
              <legend class="mb-2 text-sm font-semibold text-ink-2">Condition first (yours to decide)</legend>
              {CONDITIONS.map(([v, label, hint]) => (
                <motion.label
                  key={v}
                  whileTap={{ scale: 0.98 }}
                  class={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${f.condition === v ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong"}`}
                >
                  <input type="radio" name="condition" class="sr-only" disabled={!open} checked={f.condition === v} onChange={() => setFacts({ condition: v })} />
                  <span class={`grid size-5 flex-none place-items-center rounded-full border-2 ${f.condition === v ? "border-accent" : "border-line-strong"}`}>
                    {f.condition === v && <motion.span layoutId="cond-dot" class="size-2.5 rounded-full bg-accent" transition={SPRING} />}
                  </span>
                  <span>
                    <span class="block font-semibold">{label}</span>
                    <span class="text-sm text-muted">{hint}</span>
                  </span>
                </motion.label>
              ))}
              {r && r.condition !== "unknown" && <p class="text-sm text-muted">From the photos it looks {r.condition === "parts" ? "faulty or incomplete" : r.condition}. You decide.</p>}
            </fieldset>
  );
  return (
    <div class="grid gap-5">
      {conditionPicker}
      {busy === "review" ? (
        <Working label="Claude is looking at the photos (up to a minute)" lines={4} />
      ) : !r ? (
        open && (
          <StartCard
            title="Check the photos with Claude"
            sub={f.condition ? `What the item is, and what's missing, from your ${plural(draft.photos.length, "photo")}. About 3 to 6p.` : "Choose the condition above first: it changes what Claude suggests."}
            onClick={onReview}
            disabled={busy !== null || !f.condition}
          />
        )
      ) : (
        open && (
          <button class="btn-link inline-flex w-fit items-center gap-1 text-sm" disabled={busy !== null} onClick={onReview}>
            <Icons.refresh size={14} /> Check again (after adding photos)
          </button>
        )
      )}
      {r && (
        <>
          {!unused && text("works", "Does it work? What did you test?")}
          {text("marks", unused ? "Damage to the box or packaging" : "Marks, scratches or wear", "Be honest: it saves returns. Leave blank if there are none.")}
          {text("included", "What's included")}
          {text("missing", "Anything missing")}
          {r.questions.length > 0 && (
            <div class="evidence grid gap-3">
              <p class="flex items-center gap-2 text-sm font-semibold">
                <Icons.message size={16} /> Claude needs to check with you
              </p>
              {r.questions.map((q) => (
                <Field key={q.id} label={q.question} hint={q.why}>
                  <textarea rows={2} disabled={!open} value={f.answers[q.id] ?? ""} onInput={(e) => setFacts({ answers: { [q.id]: e.currentTarget.value } })} />
                </Field>
              ))}
            </div>
          )}
          {text("other", "Anything else a buyer should know")}
          {open && <p class="text-sm text-muted">Saved when you press Next. These go in the listing as from you.</p>}
        </>
      )}
    </div>
  );
}

// ---- Step 3: category and the listing text ----

function ListingStep(props: { draft: Draft; open: boolean; busy: string | null; onCategory: (id: string) => void; onCompose: () => void; onEdit: (b: unknown) => void }) {
  const { draft, open, busy } = props;
  const l = draft.listing;
  const [title, setTitle] = useState(l?.title ?? "");
  const [desc, setDesc] = useState(l?.description ?? "");
  const [addName, setAddName] = useState("");
  const [addValue, setAddValue] = useState("");
  useEffect(() => {
    setTitle(l?.title ?? "");
    setDesc(l?.description ?? "");
  }, [l?.title, l?.description]);
  const missingRequired = (draft.aspects ?? []).filter((a) => a.required && !l?.specifics.some((x) => x.name === a.name));
  const addAspect = (draft.aspects ?? []).find((a) => a.name === addName);
  return (
    <div class="grid gap-5">
      {draft.categories && draft.categories.length > 0 ? (
        <Field label="Category (eBay's suggestions)">
          <select disabled={!open || busy !== null} value={draft.category?.id ?? ""} onChange={(e) => props.onCategory(e.currentTarget.value)}>
            {draft.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.path ? `${c.path} > ` : ""}
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <p class="error">eBay suggested no category. Go back to the photos, add a clearer one of the label, and check again.</p>
      )}
      {busy === "compose" ? (
        <Working label="Claude is writing it (up to a minute)" />
      ) : (
        open &&
        draft.category &&
        (!l ? (
          <StartCard title="Write it with Claude" sub="From the photos, your facts and published specs only. About 2 to 5p." onClick={props.onCompose} disabled={busy !== null} />
        ) : (
          <button class="btn-link inline-flex w-fit items-center gap-1 text-sm" disabled={busy !== null} onClick={props.onCompose}>
            <Icons.refresh size={14} /> Write it again
          </button>
        ))
      )}
      {l && busy !== "compose" && (
        <>
          <Field label="Title" hint={`${80 - title.length} characters left`}>
            <input disabled={!open} value={title} maxLength={80} onInput={(e) => setTitle(e.currentTarget.value)} onBlur={(e) => e.currentTarget.value !== l.title && props.onEdit({ title: e.currentTarget.value })} />
          </Field>
          <Field label="Description" hint="Saved when you leave the box.">
            <textarea disabled={!open} rows={9} value={desc} onInput={(e) => setDesc(e.currentTarget.value)} onBlur={(e) => e.currentTarget.value !== l.description && props.onEdit({ description: e.currentTarget.value })} />
          </Field>
          <div>
            <p class="kind">Item specifics</p>
            <ul class="m-0 grid gap-1.5 p-0">
              {l.specifics.map((x) => (
                <li key={x.name} class="flex list-none flex-wrap items-center gap-2 text-sm">
                  <strong>{x.name}:</strong> {x.values.join(", ")}
                  <Chip>{x.source === "photo" ? `photo ${x.ref}` : x.source === "you" ? "from you" : "published spec"}</Chip>
                  {open && (
                    <button class="btn-link" disabled={busy !== null} onClick={() => props.onEdit({ removeSpecific: x.name })} aria-label={`Remove ${x.name}`}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {missingRequired.length > 0 && <p class="flag">eBay requires: {missingRequired.map((a) => a.name).join(", ")}. Add them below if you know them.</p>}
          {l.dropped.length > 0 && (
            <details class="text-sm">
              <summary class="cursor-pointer">{l.dropped.length} left out because no source showed them</summary>
              <ul class="mt-2 grid gap-1 pl-5">
                {l.dropped.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </details>
          )}
          {open && (
            <div class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <select value={addName} onChange={(e) => (setAddName(e.currentTarget.value), setAddValue(""))} aria-label="Item specific to add">
                <option value="">Add an item specific (from you)…</option>
                {(draft.aspects ?? []).map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                    {a.required ? " (required)" : ""}
                  </option>
                ))}
              </select>
              {addAspect?.selectionOnly ? (
                <select value={addValue} onChange={(e) => setAddValue(e.currentTarget.value)} aria-label="Value">
                  <option value="">Pick…</option>
                  {addAspect.values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={addValue} placeholder="Value" onInput={(e) => setAddValue(e.currentTarget.value)} aria-label="Value" list={addAspect ? "wizard-values" : undefined} />
              )}
              {addAspect && !addAspect.selectionOnly && (
                <datalist id="wizard-values">
                  {addAspect.values.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              )}
              <button class="btn btn-secondary" disabled={!addName || !addValue.trim() || busy !== null} onClick={() => (props.onEdit({ addSpecific: { name: addName, value: addValue } }), setAddName(""), setAddValue(""))}>
                Add
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- Step 4: price ----

function PriceStep({ draft, open, busy, onCheck, onChoose }: { draft: Draft; open: boolean; busy: string | null; onCheck: () => void; onChoose: (b: unknown) => void }) {
  const p = draft.pricing;
  const [own, setOwn] = useState(draft.price?.kind === "own" ? String(draft.price.value) : "");
  const [floor, setFloor] = useState(draft.price?.floor != null ? String(draft.price.floor) : "");
  const [offers, setOffers] = useState(draft.price?.bestOffer ?? true);
  // The engine runs once on arrival, when it hasn't priced this draft yet.
  useEffect(() => {
    if (open && !p && !busy) onCheck();
  }, []);
  const choose = (value: number | string) => onChoose({ value, floor: floor.trim() === "" ? null : Number(floor), bestOffer: offers });
  const options = p ? [p.options[0] ? { ...p.options[0], tag: "Sells sooner" } : null, p.price != null ? { price: p.price, daysToSell: p.options[1]?.daysToSell ?? 0, tag: "Recommended" } : null, p.options[2] ? { ...p.options[2], tag: "Patient" } : null].filter((o): o is { price: number; daysToSell: number; tag: string } => Boolean(o)) : [];
  const chosen = draft.price?.value;
  const floorBad = floor.trim() !== "" && (Number.isNaN(num(floor)) || (chosen != null && num(floor) > chosen));
  return (
    <div class="grid gap-5">
      {busy === "price-check" ? (
        <div class="card">
          <p class="text-sm font-semibold text-muted">Checking what the same item sells for…</p>
          <div class="skeleton mt-4 h-10 w-48" />
          <div class="skeleton mt-4 h-2 w-full" />
        </div>
      ) : (
        !p &&
        open && <StartCard title="Price it" sub="The pricing engine, from real sold listings of the same item in the same condition." onClick={onCheck} disabled={busy !== null} />
      )}
      {p && busy !== "price-check" && (
        <motion.div class="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ease: EASE_OUT }}>
          {p.strategy === "ask" ? <p class="font-semibold">{p.question}</p> : <p class="text-sm text-ink-2">{p.why}</p>}
          {options.length > 0 && p.strategy !== "ask" && (
            <div class="mt-4 grid gap-2 sm:grid-cols-3">
              {options.map((o) => (
                <motion.button
                  key={o.tag}
                  whileTap={{ scale: 0.97 }}
                  class={`rounded-2xl border p-4 text-left transition-colors ${chosen === o.price ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong"}`}
                  disabled={!open || busy !== null}
                  onClick={() => choose(o.price)}
                  aria-pressed={chosen === o.price}
                >
                  <span class="block text-xs font-semibold text-muted">{o.tag}</span>
                  <span class="mt-1 block text-2xl font-bold tabular-nums">{money(o.price)}</span>
                  {o.daysToSell > 0 && <span class="text-xs text-muted">about {Math.round(o.daysToSell)} days to sell</span>}
                </motion.button>
              ))}
            </div>
          )}
          {open && (
            <button class="btn-link mt-4 inline-flex items-center gap-1 text-sm" disabled={busy !== null} onClick={onCheck}>
              <Icons.refresh size={14} /> Check again
            </button>
          )}
        </motion.div>
      )}
      {p && p.strategy === "ask" && p.reason === "no_sales" && (
        <div class="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Your price (£)" hint="Nothing comparable has sold, so the price is yours to set.">
            <input type="number" inputMode="decimal" min="0.99" step="0.01" disabled={!open} value={own} onInput={(e) => setOwn(e.currentTarget.value)} />
          </Field>
          <button class="btn btn-primary" disabled={!open || !(num(own) > 0) || busy !== null} onClick={() => choose(own)}>
            Set as your price
          </button>
        </div>
      )}
      {p && (
        <>
          <Field label="Lowest price you'd accept (floor, optional, £)" hint={floorBad ? "The floor can't be above the price." : "Offers below it are never suggested to you."}>
            <input type="number" inputMode="decimal" step="0.01" disabled={!open} value={floor} onInput={(e) => setFloor(e.currentTarget.value)} onBlur={() => chosen != null && !floorBad && num(floor) !== (draft.price?.floor ?? NaN) && choose(chosen)} />
          </Field>
          <Toggle label="Let buyers make offers" sub="You answer every one." checked={offers} disabled={!open} onChange={() => (setOffers(!offers), chosen != null && onChoose({ value: chosen, floor: floor.trim() === "" ? null : Number(floor), bestOffer: !offers }))} />
          <p class="text-sm text-muted">Returns accepted, buyer pays return postage.</p>
        </>
      )}
      {draft.price && (
        <p class="result">
          Listing at {money(draft.price.value)} ({draft.price.kind === "own" ? "your own price" : "the engine's"}){draft.price.floor != null ? `, floor ${money(draft.price.floor)}` : ""}.
        </p>
      )}
    </div>
  );
}

// ---- Step 5: postage ----

/** eBay's Simple Delivery sizes, as eBay's listing form shows them (src/postage.ts holds the same list and decides). */
const PARCEL_SIZES = [
  { code: "large_letter_1kg", group: "Large letter", label: "Up to 1 kg", dims: "35 x 25 x 2.5 cm" },
  { code: "small_parcel_1kg", group: "Small parcel", label: "Up to 1 kg", dims: "45 x 35 x 16 cm" },
  { code: "small_parcel_2kg", group: "Small parcel", label: "Up to 2 kg", dims: "45 x 35 x 16 cm" },
  { code: "medium_parcel_1kg", group: "Medium parcel", label: "Up to 1 kg", dims: "61 x 46 x 46 cm" },
  { code: "medium_parcel_2kg", group: "Medium parcel", label: "Up to 2 kg", dims: "61 x 46 x 46 cm" },
  { code: "medium_parcel_10kg", group: "Medium parcel", label: "Up to 10 kg", dims: "61 x 46 x 46 cm" },
  { code: "medium_parcel_20kg", group: "Medium parcel", label: "Up to 20 kg", dims: "61 x 46 x 46 cm" },
] as const;
const sizeText = (code: string | null | undefined) => {
  const z = PARCEL_SIZES.find((x) => x.code === code);
  return z ? `${z.group}, ${z.label.toLowerCase()}` : null;
};

interface PostageForm {
  postcode: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  weightKg: string;
  cost: string;
  carrier: { carrier: string; service: string } | null;
  collect: boolean;
  only: boolean;
  /** A Simple Delivery size code, "courier", or "" to let the app work it out from the parcel. */
  size: string;
  /** True once K picks the size from the list; then it's saved as K's choice. */
  sizeMine: boolean;
}
const postageForm = (d: Draft): PostageForm => ({
  postcode: d.postage?.postcode ?? "",
  lengthCm: String(d.parcel?.lengthCm ?? ""),
  widthCm: String(d.parcel?.widthCm ?? ""),
  heightCm: String(d.parcel?.heightCm ?? ""),
  weightKg: String(d.parcel?.weightKg ?? ""),
  cost: d.postage && !d.postage.collectionOnly ? String(d.postage.cost) : "",
  carrier: d.postage?.carrier ? { carrier: d.postage.carrier, service: d.postage.service ?? "" } : null,
  collect: d.postage?.collectionOffered ?? false,
  only: d.postage?.collectionOnly ?? false,
  size: d.postage?.mode === "courier" ? "courier" : (d.postage?.size ?? ""),
  sizeMine: d.postage?.sizeBy === "you",
});
const parcelOf = (f: PostageForm) => ({ lengthCm: num(f.lengthCm), widthCm: num(f.widthCm), heightCm: num(f.heightCm), weightKg: num(f.weightKg) });
const postageReady = (f: PostageForm) => f.postcode.trim().length >= 5 && (f.only || num(f.cost) >= 0);
const postageBody = (f: PostageForm) => {
  const parcel = parcelOf(f);
  return {
    cost: f.only ? 0 : num(f.cost),
    carrier: f.carrier?.carrier ?? null,
    service: f.carrier?.service ?? null,
    source: f.carrier ? "parcel2go" : "you",
    collectionOffered: f.collect,
    collectionOnly: f.only,
    postcode: f.postcode,
    parcel: Object.values(parcel).every((v) => v > 0) ? parcel : null,
    // K's own choice is kept; otherwise the server works the size out from the parcel.
    ...(f.sizeMine && f.size === "courier" ? { mode: "courier" } : f.sizeMine && f.size ? { size: f.size } : {}),
  };
};

const SOURCE_WORD = { spec: "from the manufacturer's specs", estimate: "estimated", unknown: "not known" } as const;

function PostageStep(props: {
  draft: Draft;
  open: boolean;
  busy: string | null;
  form: PostageForm | null;
  setForm: Dispatch<StateUpdater<PostageForm | null>>;
  onQuote: (p: unknown) => void;
  onPlan: () => void;
}) {
  const { draft, open, busy, form, setForm, onQuote } = props;
  const f = form ?? postageForm(draft);
  const plan = draft.parcelPlan;
  // Merged into the latest state, so quick successive edits (autofill, fast typing) never undo each other.
  const set = (patch: Partial<PostageForm>) => setForm((cur) => ({ ...(cur ?? postageForm(draft)), ...patch }));
  useEffect(() => {
    if (!form) set({});
    if (!f.postcode) api<{ postcode: string | null }>("/drafts/defaults").then((d) => d.postcode && setForm((cur) => ({ ...(cur ?? postageForm(draft)), postcode: cur?.postcode || d.postcode! }))).catch(() => {});
    // Worked out on arrival: the packed parcel, its size, quotes and the postage.
    if (open && !plan && !busy) props.onPlan();
  }, []);
  // A fresh plan (or new quotes) refills the form.
  useEffect(() => {
    if (plan) setForm(postageForm(draft));
  }, [plan?.at, draft.quotes?.at]);
  const dim = (k: "lengthCm" | "widthCm" | "heightCm" | "weightKg", label: string) => (
    <Field label={label}>
      <input type="number" inputMode="decimal" min="0" step="0.1" disabled={!open} value={f[k]} onInput={(e) => set({ [k]: e.currentTarget.value, ...(f.sizeMine ? {} : { size: "" }) })} />
    </Field>
  );
  const parcelOk = Object.values(parcelOf(f)).every((v) => v > 0);
  const courier = f.size === "courier";
  const sized = sizeText(f.size);
  const item = plan?.item;

  if (busy === "postage-plan") return <Working label="Working out the parcel and the postage" lines={4} />;
  return (
    <div class="grid gap-5">
      <Toggle label="Collection only" sub="No postage: the buyer collects it from you." checked={f.only} disabled={!open} onChange={() => set({ only: !f.only })} />
      {!f.only && (
        <>
          {plan && plan.missing.length > 0 && (
            <div class="flag">
              <p class="font-semibold">Measure it, please</p>
              <p class="mt-1 text-sm">The size couldn't be worked out from anything known about it. Give {plan.missing.join(" and ")}, packed as you'll post it, then Get prices.</p>
            </div>
          )}
          <div class="card grid gap-4">
            <div>
              <p class="kind">The parcel</p>
              {plan ? (
                <p class="text-sm text-muted">
                  {plan.packaging}.{" "}
                  {item && item.source !== "unknown" && (
                    <>
                      The item {item.lengthCm && item.widthCm && item.heightCm ? `is about ${item.lengthCm} x ${item.widthCm} x ${item.heightCm} cm` : ""}
                      {item.weightKg ? `${item.lengthCm ? ", " : "weighs "}${item.weightKg} kg` : ""} ({SOURCE_WORD[item.source]}).
                    </>
                  )}{" "}
                  {plan.by === "claude" && <Chip tone={plan.confidence === "high" ? "good" : plan.confidence === "medium" ? "accent" : "warn"}>{plan.confidence === "high" ? "From published specs" : plan.confidence === "medium" ? "Estimated" : "Needs measuring"}</Chip>}
                </p>
              ) : (
                <p class="text-sm text-muted">The packed parcel's size and weight, as you'll post it.</p>
              )}
            </div>
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {dim("lengthCm", "Length, cm")}
              {dim("widthCm", "Width, cm")}
              {dim("heightCm", "Height, cm")}
              {dim("weightKg", "Weight, kg")}
            </div>
            {open && (
              <div class="flex flex-wrap gap-2">
                <button class="btn btn-secondary w-fit" disabled={busy !== null || !parcelOk} onClick={() => onQuote(parcelOf(f))}>
                  {busy === "quotes" ? "Getting prices…" : "Get prices"}
                </button>
                <button class="btn btn-text w-fit" disabled={busy !== null} onClick={props.onPlan}>
                  <Icons.refresh size={14} /> Work it out again
                </button>
              </div>
            )}
          </div>

          <div class="card grid gap-3">
            <Field label="How it's posted" hint={f.sizeMine ? "Your choice." : "Worked out from the parcel: the smallest of eBay's sizes it fits, with a little room on the weight."}>
              <select
                disabled={!open}
                value={f.size}
                onChange={(e) => set({ size: e.currentTarget.value, sizeMine: true })}
                aria-label="Simple Delivery size, or courier"
              >
                {!f.size && <option value="">Worked out when you press Next</option>}
                {["Large letter", "Small parcel", "Medium parcel"].map((g) => (
                  <optgroup key={g} label={`eBay Simple Delivery: ${g} (${PARCEL_SIZES.find((z) => z.group === g)!.dims})`}>
                    {PARCEL_SIZES.filter((z) => z.group === g).map((z) => (
                      <option key={z.code} value={z.code}>
                        {g}, {z.label.toLowerCase()}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value="courier">Too big or heavy for Simple Delivery: courier, at the postage below</option>
              </select>
            </Field>
            {sized && !courier && (
              <div class="evidence text-sm">
                <p class="font-semibold">After it's listed: switch it to Simple Delivery</p>
                <p class="mt-1">
                  eBay doesn't let apps set Simple Delivery, so it goes live with the postage below. You'll get a to-do in the Inbox: in Seller Hub, Edit the listing, choose <strong>Buyer pays postage</strong>, then <strong>{sized}</strong>. If eBay recommends a different size there, use eBay's.
                </p>
              </div>
            )}
            {courier && <p class="text-sm text-muted">The buyer pays the postage below; after it sells, book the courier (Parcel2Go has the quote).</p>}
          </div>

          {draft.quotes?.error && <p class="rounded-xl bg-yellow-soft px-3 py-2 text-sm text-yellow">{draft.quotes.error}</p>}
          {draft.quotes && draft.quotes.quotes.length > 0 && (
            <ul class="m-0 grid gap-2 p-0">
              {draft.quotes.quotes.map((q, i) => {
                const picked = f.carrier?.carrier === q.carrier && f.carrier?.service === q.service;
                return (
                  <li key={i} class="list-none">
                    <button
                      class={`flex w-full items-center justify-between rounded-xl border px-4 py-2.5 text-left text-sm ${picked ? "border-accent bg-accent-soft" : "border-line bg-surface"}`}
                      disabled={!open}
                      onClick={() => set({ cost: String(Math.ceil(q.price * 2) / 2), carrier: { carrier: q.carrier, service: q.service } })}
                    >
                      <span>
                        <strong>{q.carrier}</strong> {q.service} {i === 0 && <Chip tone="good">Cheapest</Chip>}
                      </span>
                      <span class="font-semibold tabular-nums">{money(q.price)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <Field label="Postage the buyer pays (£)" hint={courier ? "From the cheapest quote, rounded up: refund any difference." : "Shown until you switch to Simple Delivery, when eBay sets it."}>
            <input type="number" inputMode="decimal" min="0" step="0.01" disabled={!open} value={f.cost} onInput={(e) => set({ cost: e.currentTarget.value, carrier: null })} />
          </Field>
          <Toggle label="Collection also welcome" sub="Offered free as a second option." checked={f.collect} disabled={!open} onChange={() => set({ collect: !f.collect })} />
        </>
      )}
      <Field label="Postcode it's sent from" hint="Buyers see the area only. Remembered for next time.">
        <input disabled={!open} value={f.postcode} maxLength={10} autoComplete="postal-code" onInput={(e) => set({ postcode: e.currentTarget.value })} />
      </Field>
      {open && <p class="text-sm text-muted">Saved when you press Next.</p>}
    </div>
  );
}

// ---- Step 6: review and send ----

function ReviewStep(props: { draft: Draft; busy: string | null; confirmDelete: boolean; onSubmit: () => void; onReopen: () => void; onRetry: () => void; onDelete: () => void; onInbox: () => void }) {
  const { draft, busy } = props;
  const l = draft.listing;
  const open = draft.status === "open";
  const post = draft.postage;
  const condition = CONDITIONS.find((c) => c[0] === draft.facts?.condition)?.[1];

  // eBay didn't take it: say so, and offer to send the same draft again (nothing to redo).
  if (draft.status === "submitted" && draft.label?.status === "failed")
    return (
      <div class="grid place-items-center gap-5 py-6 text-center">
        <span class="grid size-24 place-items-center rounded-full bg-yellow-soft text-yellow">
          <Icons.alert size={40} />
        </span>
        <div>
          <h2 class="text-2xl">eBay didn't take it</h2>
          <p class="mt-2 max-w-md text-muted">It was approved, but eBay refused it, so nothing was listed. Everything you entered is kept: send it again and a fresh label goes to the Inbox.</p>
          {draft.label.result && <p class="mx-auto mt-3 max-w-md rounded-xl bg-surface-2 px-3 py-2 text-left text-sm text-muted">eBay said: {draft.label.result}</p>}
        </div>
        <div class="flex flex-wrap justify-center gap-2">
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={busy !== null} onClick={props.onRetry}>
            {busy === "submit" ? "eBay is checking…" : "Send for approval again"}
          </motion.button>
          <button class="btn btn-text" disabled={busy !== null} onClick={props.onReopen}>
            Edit it first
          </button>
        </div>
      </div>
    );

  if (draft.status === "submitted" || draft.status === "published")
    return (
      <div class="grid place-items-center gap-5 py-6 text-center">
        <motion.div class="grid size-24 place-items-center rounded-full bg-green text-[#04130d]" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={SPRING} style={{ boxShadow: "0 0 60px -10px var(--green)" }}>
          <Icons.check size={44} />
        </motion.div>
        <div>
          <h2 class="text-2xl">{draft.status === "published" ? "Listed on eBay" : "Sent for approval"}</h2>
          <p class="mt-2 text-muted">{draft.status === "published" ? `Item ${draft.item_id}.${draft.postage?.mode === "simple_delivery" && sizeText(draft.postage.size) ? ` Next: switch its postage to Simple Delivery (${sizeText(draft.postage.size)}) in Seller Hub. The steps are in your Inbox to-dos.` : ""}` : `The label is waiting in the Inbox. It goes live on eBay once one of you approves it.${draft.postage?.mode === "simple_delivery" && sizeText(draft.postage.size) ? ` Then switch its postage to Simple Delivery (${sizeText(draft.postage.size)}) in Seller Hub: a to-do will remind you.` : ""}`}</p>
        </div>
        {draft.status === "submitted" && (
          <div class="flex flex-wrap justify-center gap-2">
            <button class="btn btn-primary" onClick={props.onInbox}>
              Open the Inbox <Icons.arrowRight size={16} />
            </button>
            <button class="btn btn-text" disabled={busy !== null} onClick={props.onReopen}>
              Edit it again
            </button>
          </div>
        )}
        {draft.status === "submitted" && <p class="max-w-sm text-sm text-muted">"Edit it again" works once the label is rejected, has expired or failed, or was recorded as a dry run while changes are off.</p>}
      </div>
    );

  return (
    <div class="grid gap-5">
      <div class="card overflow-hidden p-0">
        {draft.photos[0] && <img src={photoSrc(draft.photos[0])} alt="" class="aspect-[16/10] w-full object-cover" />}
        <div class="p-5">
          <div class="flex items-start justify-between gap-4">
            <h2 class="text-lg">{l?.title || draft.title || "Untitled"}</h2>
            <span class="text-2xl font-bold tabular-nums">{draft.price ? money(draft.price.value) : "No price"}</span>
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <Chip>{condition ?? "Condition not set"}</Chip>
            <Chip>{plural(draft.photos.length, "photo")}</Chip>
            <Chip>{!post ? "No postage yet" : post.collectionOnly ? "Collection only" : `Postage ${money(post.cost)}${post.collectionOffered ? " · collection welcome" : ""}`}</Chip>
            {post && !post.collectionOnly && (post.mode === "courier" ? <Chip tone="warn">Courier</Chip> : sizeText(post.size) ? <Chip tone="accent">Simple Delivery: {sizeText(post.size)}</Chip> : null)}
            {draft.price?.bestOffer && <Chip>Offers on</Chip>}
            {draft.category && <Chip>{draft.category.name}</Chip>}
          </div>
          {l && <p class="mt-4 line-clamp-6 whitespace-pre-wrap text-sm text-ink-2">{l.description}</p>}
          {l && l.specifics.length > 0 && <p class="mt-3 text-sm text-muted">{l.specifics.map((x) => `${x.name}: ${x.values.join(", ")}`).join(" · ")}</p>}
        </div>
      </div>
      {draft.missing.length > 0 ? (
        <div class="flag">
          <p class="font-semibold">Still to do</p>
          <ul class="m-0 mt-1 grid gap-1 pl-5 text-sm">
            {draft.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p class="text-sm text-muted">Send for approval runs eBay's own check first (fees shown, any problem explained), then puts the label in the Inbox.</p>
      )}
      {open && (
        <div class="flex flex-wrap gap-2">
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-approve" disabled={busy !== null || draft.missing.length > 0} onClick={props.onSubmit}>
            {busy === "submit" ? "eBay is checking…" : "Check with eBay and send for approval"}
          </motion.button>
          <button class="btn btn-danger" disabled={busy !== null} onClick={props.onDelete}>
            <Icons.trash size={16} /> {props.confirmDelete ? "Tap again to delete it and its photos" : "Delete draft"}
          </button>
        </div>
      )}
    </div>
  );
}
