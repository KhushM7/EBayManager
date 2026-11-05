import { useEffect, useRef, useState } from "preact/hooks";
import { api, apiJob, SignedOut } from "../api";
import { ago, money } from "../format";
import type { ScreenProps } from "../screens";
import { bitsToHex, CHECKLIST, hexToBits, type Issue } from "./checks";
import { processPhoto, type Processed } from "./photos";
import { tidy } from "./tidy";
import "./listing.css";

// Add Listing (docs/add-listing.md): drafts, photos, Claude's photo check, K's facts, the listing text, price,
// postage, and sending it for approval. Nothing here changes eBay: a submitted draft becomes a label in the
// Inbox, and only an approval publishes it, through the write gate. The draft is kept in the address
// (?draft=<id>) so the back button and a reload both work.

interface DraftPhoto {
  id: string;
  url: string;
  originalUrl: string;
  width: number;
  height: number;
  issues: string[];
  hash: string | null;
  edited?: { at: number; edits: string[] } | null;
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
  condition: "new" | "used" | "parts" | null;
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
  photos: DraftPhoto[];
  missing: string[];
  review?: Review | null;
  facts?: Facts | null;
  specs?: { product: string | null; specs: { name: string; value: string; source: string; sourceTitle: string }[] } | null;
  categories?: { id: string; name: string; path: string }[];
  category?: { id: string; name: string; path: string } | null;
  aspects?: Aspect[];
  listing?: { title: string; description: string; specifics: { name: string; values: string[]; source: string; ref: string }[]; dropped: string[]; editedByK: boolean } | null;
  pricing?: { strategy: string; price: number | null; total: number | null; why: string; confidence: number; question?: string; reason?: string; options: { price: number; daysToSell: number }[] } | null;
  price?: { value: number; kind: "engine" | "own"; floor: number | null; bestOffer: boolean } | null;
  parcel?: { lengthCm: number; widthCm: number; heightCm: number; weightKg: number } | null;
  quotes?: { quotes: { carrier: string; service: string; price: number }[]; error?: string } | null;
  postage?: { cost: number; carrier: string | null; service: string | null; collectionOffered: boolean; collectionOnly: boolean; postcode: string } | null;
  proposal_id?: string | null;
  item_id?: string | null;
}

const ISSUE_WORD: Record<string, string> = { small: "Small", dark: "Dark", bright: "Too bright", blur: "Blurry", duplicate: "Same as another" };
const EDIT_WORD: Record<string, string> = { white_balance: "white balance", exposure: "exposure", background: "background to white", crop: "cropped" };
const MAX_PHOTOS = 24;

const draftParam = () => new URLSearchParams(location.search).get("draft");
function openDraft(id: string | null) {
  history.pushState(null, "", id ? `/sell?draft=${encodeURIComponent(id)}` : "/sell");
  dispatchEvent(new PopStateEvent("popstate"));
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
  if (p.issues.length) q.set("issues", p.issues.map((i) => i.code).join(","));
  return sendJpeg(`/drafts/${draftId}/photos?${q}`, p.blob);
}

export function Sell(props: ScreenProps) {
  const [id, setId] = useState(draftParam());
  useEffect(() => {
    const on = () => setId(draftParam());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return id ? <DraftView {...props} id={id} /> : <Drafts {...props} />;
}

function DraftRow({ d }: { d: Draft }) {
  return (
    <li>
      <a class="sell-draft paper" href={`/sell?draft=${d.id}`} onClick={(e) => (e.preventDefault(), openDraft(d.id))}>
        {d.photos[0] ? <img src={photoSrc(d.photos[0])} alt="" loading="lazy" /> : <span class="sell-noimg" aria-hidden="true" />}
        <span>
          <strong>{d.listing?.title || d.title || "Untitled"}</strong>
          <span class="small muted">
            {d.status === "submitted" ? "Waiting for approval · " : d.status === "published" ? `Listed, item ${d.item_id} · ` : ""}
            {d.photos.length} photo{d.photos.length === 1 ? "" : "s"} · {d.created_by} · changed {ago(d.updated_at)}
          </span>
        </span>
      </a>
    </li>
  );
}

function Drafts({ onSignedOut }: ScreenProps) {
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [sent, setSent] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => (e instanceof SignedOut ? onSignedOut() : setError((e as Error).message));
  useEffect(() => {
    api<Draft[]>("/drafts").then(setRows).catch(fail);
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
    <>
      <div class="page-head">
        <h1 class="title-in">Sell</h1>
        <p>Start with photos. The app checks each one as you take it, then helps with the facts, price and postage. Nothing is listed until one of you approves it.</p>
      </div>
      <p>
        <button class="btn btn-stamp" disabled={busy} onClick={create}>
          New listing
        </button>
      </p>
      {error && <p class="error">{error}</p>}
      {rows && rows.length > 0 && (
        <section class="section">
          <h2>Drafts</h2>
          <ol class="sell-drafts">{rows.map((d) => <DraftRow key={d.id} d={d} />)}</ol>
          <p class="small muted">Drafts nobody touches for 30 days are deleted, with their photos.</p>
        </section>
      )}
      {sent.length > 0 && (
        <section class="section">
          <h2>Sent and listed</h2>
          <ol class="sell-drafts">{sent.map((d) => <DraftRow key={d.id} d={d} />)}</ol>
        </section>
      )}
    </>
  );
}

interface Pending {
  key: string;
  file: File;
  processed?: Processed;
  state: "checking" | "review" | "uploading" | "error";
  error?: string;
}

function DraftView({ id, onSignedOut, onChanged }: ScreenProps & { id: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;

  const fail = (e: unknown) => (e instanceof SignedOut ? onSignedOut() : setError((e as Error).message));
  const take = (d: Draft) => (setDraft(d), setTitle(d.title ?? ""));
  const load = () => api<Draft>(`/drafts/${id}`).then(take).catch(fail);
  useEffect(() => {
    load();
  }, [id]);

  /** Runs one step (a request or a background job), then reloads the draft. */
  const step = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    setNote(null);
    try {
      const out: any = await fn();
      if (out?.note) setNote(out.note);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  const post = (path: string, body: unknown = {}) => api<Draft>(`/drafts/${id}${path}`, { body });
  const job = (path: string) => apiJob<Draft>(`/drafts/${id}${path}`, {});

  const update = (key: string, patch: Partial<Pending>) => setPending((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const drop = (key: string) => setPending((ps) => ps.filter((p) => p.key !== key));
  const send = async (p: Pending) => {
    update(p.key, { state: "uploading" });
    try {
      take(await upload(id, p.processed!));
      drop(p.key);
    } catch (e) {
      if (e instanceof SignedOut) return onSignedOut();
      update(p.key, { state: "error", error: (e as Error).message });
    }
  };

  // Each new photo is checked on the phone; a good one uploads at once, one with issues waits for a decision.
  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    const room = MAX_PHOTOS - (draftRef.current?.photos.length ?? 0) - pending.length;
    const chosen = [...list].slice(0, Math.max(0, room));
    if (chosen.length < list.length) setError(`eBay allows ${MAX_PHOTOS} photos: only the first ${chosen.length} were added.`);
    const items: Pending[] = chosen.map((file, i) => ({ key: `${Date.now()}-${i}`, file, state: "checking" }));
    setPending((ps) => [...ps, ...items]);
    const seen = (draftRef.current?.photos ?? []).map((p) => p.hash).filter((h): h is string => Boolean(h)).map(hexToBits);
    for (const item of items) {
      try {
        const processed = await processPhoto(item.file, seen);
        seen.push(processed.hash);
        if (processed.issues.length) update(item.key, { processed, state: "review" });
        else await send({ ...item, processed });
      } catch (e) {
        update(item.key, { state: "error", error: (e as Error).message || "That file couldn't be read as a photo." });
      }
    }
  };

  if (!draft)
    return (
      <>
        <BackLink />
        {error ? <p class="error">{error}</p> : <div class="page-head" aria-busy="true" />}
      </>
    );

  const open = draft.status === "open";
  const count = draft.photos.length;
  const order = async (photoId: string, by: number) => {
    const ids = draft.photos.map((p) => p.id);
    const i = ids.indexOf(photoId);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await step("order", () => post("/order", { order: ids }));
  };

  return (
    <>
      <BackLink />
      <div class="page-head">
        <h1 class="title-in">{draft.listing?.title || draft.title || "New listing"}</h1>
        <p>
          {count ? `${count} of ${MAX_PHOTOS} photos.` : "No photos yet."} Started by {draft.created_by} {ago(draft.created_at)}.
          {draft.status === "submitted" && " Waiting for approval in the Inbox."}
          {draft.status === "published" && ` Listed on eBay: item ${draft.item_id}.`}
        </p>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p class="result" role="status">
          {note}
        </p>
      )}

      {open && (
        <section class="paper sell-what">
          <label class="form">
            What is it, in your words? (optional; the photos come first)
            <input
              value={title}
              maxLength={120}
              placeholder="e.g. Dyson vacuum, needs a new hose"
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              onBlur={() => (draft.title ?? "") !== title.trim() && step("title", () => post("", { title }))}
            />
          </label>
        </section>
      )}

      {open && (
        <details class="section sell-checklist" open={count === 0}>
          <summary>
            <h2>Before you start</h2>
          </summary>
          <ul class="paper">
            {CHECKLIST.map((c) => (
              <li key={c.title}>
                <strong>{c.title}.</strong> {c.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      <section class="section">
        <h2>1. Photos</h2>
        {open && (
          <>
            <div class="actions">
              <button class="btn btn-stamp" disabled={count >= MAX_PHOTOS} onClick={() => camera.current?.click()}>
                Take photos
              </button>
              <button class="btn btn-ink" disabled={count >= MAX_PHOTOS} onClick={() => files.current?.click()}>
                Choose photos
              </button>
              <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (add((e.target as HTMLInputElement).files), ((e.target as HTMLInputElement).value = ""))} />
              <input ref={files} type="file" accept="image/*" multiple hidden onChange={(e) => (add((e.target as HTMLInputElement).files), ((e.target as HTMLInputElement).value = ""))} />
            </div>
            <p class="small muted">Photos are shrunk and their location data removed on this device before upload. Only the three of you can see them.</p>
          </>
        )}
        {pending.length > 0 && (
          <ul class="sell-pending">
            {pending.map((p) => (
              <PendingCard key={p.key} p={p} onKeep={() => send(p)} onRetake={() => (drop(p.key), camera.current?.click())} onDiscard={() => drop(p.key)} />
            ))}
          </ul>
        )}
        {count > 0 && (
          <ol class="sell-grid">
            {draft.photos.map((ph, i) => (
              <PhotoCard
                key={ph.id}
                ph={ph}
                i={i}
                last={i === count - 1}
                open={open}
                draftId={id}
                onMove={(by) => order(ph.id, by)}
                onRemove={() => step("remove", () => post(`/photos/${ph.id}/remove`))}
                onChanged={(d) => take(d)}
                onError={fail}
              />
            ))}
          </ol>
        )}
      </section>

      {count > 0 && (
        <ReviewStep draft={draft} busy={busy} onRun={() => step("review", () => job("/review"))} />
      )}
      {draft.review && <FactsStep draft={draft} busy={busy} onSave={(f) => step("facts", () => post("/facts", f))} />}
      {draft.review && draft.facts?.condition && (
        <ListingStep
          draft={draft}
          busy={busy}
          onCategory={(categoryId) => step("category", () => post("/category", { categoryId }))}
          onCompose={() => step("compose", () => job("/compose"))}
          onEdit={(b) => step("listing", () => post("/listing", b))}
        />
      )}
      {draft.listing && <PriceStep draft={draft} busy={busy} onCheck={() => step("price-check", () => job("/price-check"))} onChoose={(b) => step("price", () => post("/price", b))} />}
      {draft.price && (
        <PostageStep draft={draft} busy={busy} onQuote={(p) => step("quotes", () => post("/quotes", p))} onSave={(b) => step("postage", () => post("/postage", b))} />
      )}

      <section class="section paper">
        <h2>7. Send for approval</h2>
        {open && draft.missing.length > 0 && (
          <ul class="small">
            {draft.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        {open && (
          <p>
            <button class="btn btn-stamp" disabled={busy !== null || draft.missing.length > 0} onClick={() => step("submit", async () => (await post("/submit"), onChanged(), { note: "Sent: eBay checked it, and the label is waiting in the Inbox." }))}>
              {busy === "submit" ? "eBay is checking it" : "Check with eBay and send for approval"}
            </button>
          </p>
        )}
        {draft.status === "submitted" && (
          <p>
            The label is in the Inbox for one of you to approve. Rejected, or recorded as a dry run while changes are off?{" "}
            <button class="btn-link" onClick={() => step("reopen", () => post("/reopen"))}>
              Edit it again
            </button>
          </p>
        )}
        {open && (
          <button class="btn btn-text" onClick={() => (confirmDelete ? step("delete", async () => (await post("/delete"), openDraft(null))) : setConfirmDelete(true))}>
            {confirmDelete ? "Tap again to delete this draft and its photos" : "Delete draft"}
          </button>
        )}
      </section>
    </>
  );
}

function BackLink() {
  return (
    <p>
      <a class="btn-link" href="/sell" onClick={(e) => (e.preventDefault(), openDraft(null))}>
        ← All drafts
      </a>
    </p>
  );
}

function PendingCard({ p, onKeep, onRetake, onDiscard }: { p: Pending; onKeep: () => void; onRetake: () => void; onDiscard: () => void }) {
  return (
    <li class="sell-pending-card paper" aria-live="polite">
      {p.processed ? <img src={p.processed.preview} alt="" /> : <span class="sell-noimg" aria-hidden="true" />}
      <div>
        {p.state === "checking" && <p>Checking the photo…</p>}
        {p.state === "uploading" && <p>Uploading…</p>}
        {p.state === "error" && (
          <>
            <p class="error">{p.error}</p>
            <button class="btn-link" onClick={onDiscard}>
              Dismiss
            </button>
          </>
        )}
        {p.state === "review" && p.processed && (
          <>
            <ul class="sell-issues">
              {p.processed.issues.map((i: Issue) => (
                <li key={i.code}>{i.advice}</li>
              ))}
            </ul>
            <div class="actions">
              <button class="btn btn-stamp" onClick={onRetake}>
                Retake
              </button>
              <button class="btn btn-text" onClick={onKeep}>
                Keep anyway
              </button>
              <button class="btn-link" onClick={onDiscard}>
                Discard
              </button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/** One photo: order, remove, and the background tidy-up (ordinary edits only; the original is kept). */
function PhotoCard(props: {
  ph: DraftPhoto;
  i: number;
  last: boolean;
  open: boolean;
  draftId: string;
  onMove: (by: number) => void;
  onRemove: () => void;
  onChanged: (d: Draft) => void;
  onError: (e: unknown) => void;
}) {
  const { ph, i, last, open, draftId } = props;
  const [preview, setPreview] = useState<{ url: string; blob: Blob; edits: string[] } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const runTidy = async () => {
    setWorking(true);
    setRefused(null);
    try {
      const img = new Image();
      img.src = ph.originalUrl;
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
      props.onChanged(await sendJpeg(`/drafts/${draftId}/photos/${ph.id}/edited?edits=${preview.edits.join(",")}`, preview.blob));
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

  return (
    <li class="sell-photo paper">
      <img src={photoSrc(ph)} alt={`Photo ${i + 1}`} loading="lazy" />
      <div class="sell-photo-meta">
        <span class="small muted">{i + 1}</span>
        {i === 0 && <span class="state state-info">Main photo</span>}
        {ph.use_edited && ph.edited && <span class="state state-applied">Tidied</span>}
        {ph.issues.map((code) => (
          <span class="state state-held" key={code}>
            {ISSUE_WORD[code] ?? code}
          </span>
        ))}
      </div>
      {preview && (
        <div class="sell-tidy">
          <p class="small">
            Tidied: {preview.edits.map((e) => EDIT_WORD[e] ?? e).join(", ")}. Nothing on the item itself was changed.
          </p>
          <img src={preview.url} alt="Tidied version" />
          <div class="actions">
            <button class="btn btn-stamp" disabled={working} onClick={useTidied}>
              Use tidied
            </button>
            <button class="btn btn-text" onClick={() => setPreview(null)}>
              Keep original
            </button>
          </div>
        </div>
      )}
      {refused && <p class="small sell-issues">{refused}</p>}
      {open && (
        <div class="sell-photo-actions">
          <button class="btn-link" disabled={i === 0} onClick={() => props.onMove(-1)} aria-label={`Move photo ${i + 1} earlier`}>
            ← Earlier
          </button>
          <button class="btn-link" disabled={last} onClick={() => props.onMove(1)} aria-label={`Move photo ${i + 1} later`}>
            Later →
          </button>
          {ph.edited ? (
            <button class="btn-link" onClick={() => choose(!ph.use_edited)}>
              {ph.use_edited ? "Use original" : "Use tidied"}
            </button>
          ) : (
            <button class="btn-link" disabled={working} onClick={runTidy}>
              {working ? "Tidying…" : "Tidy background"}
            </button>
          )}
          <button class="btn-link" onClick={props.onRemove} aria-label={`Remove photo ${i + 1}`}>
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

function ReviewStep({ draft, busy, onRun }: { draft: Draft; busy: string | null; onRun: () => void }) {
  const r = draft.review;
  return (
    <section class="section">
      <h2>2. Photo check</h2>
      {draft.status === "open" && (
        <p>
          <button class={`btn ${r ? "btn-text" : "btn-stamp"}`} disabled={busy !== null} onClick={onRun}>
            {busy === "review" ? "Claude is looking at the photos (up to a minute)" : r ? "Check again (after adding photos)" : "Check the photos"}
          </button>{" "}
          <span class="small muted">Claude says what the item is and what's missing. About 3 to 6p.</span>
        </p>
      )}
      {r && (
        <div class="paper sell-review">
          <p>
            <strong>{r.product}</strong> {r.exact ? <span class="state state-applied">Exact model</span> : <span class="state state-held">Model not certain</span>}
          </p>
          {r.missingShots.length > 0 && (
            <>
              <p class="kind">Shots to add</p>
              <ul>
                {r.missingShots.map((s) => (
                  <li key={s.shot}>
                    <strong>{s.shot}.</strong> {s.why}
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.photoNotes.length > 0 && (
            <ul class="small">
              {r.photoNotes.map((n, i) => (
                <li key={i}>
                  Photo {n.photo}: {n.note}
                </li>
              ))}
            </ul>
          )}
          <details class="small">
            <summary>What the photos show ({r.visibleFacts.length + r.flaws.length})</summary>
            <ul>
              {r.visibleFacts.map((f, i) => (
                <li key={`f${i}`}>
                  {f.fact} <span class="muted">(photo {f.photo})</span>
                </li>
              ))}
              {r.flaws.map((f, i) => (
                <li key={`x${i}`}>
                  Flaw: {f.text} <span class="muted">(photo {f.photo})</span>
                </li>
              ))}
            </ul>
          </details>
          {draft.specs && draft.specs.specs.length > 0 && (
            <details class="small">
              <summary>
                {draft.specs.specs.length} published specs for the {draft.specs.product}
              </summary>
              <ul>
                {draft.specs.specs.map((s) => (
                  <li key={s.name}>
                    {s.name}: <strong>{s.value}</strong>{" "}
                    <a href={s.source} target="_blank" rel="noopener noreferrer">
                      {s.sourceTitle || "source"}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function FactsStep({ draft, busy, onSave }: { draft: Draft; busy: string | null; onSave: (f: Facts) => void }) {
  const init: Facts = draft.facts ?? { condition: null, works: null, marks: null, included: null, missing: null, other: null, answers: {} };
  const [f, setF] = useState<Facts>(init);
  const set = (k: keyof Facts, v: string) => setF({ ...f, [k]: v });
  const open = draft.status === "open";
  const text = (k: "works" | "marks" | "included" | "missing" | "other", label: string) => (
    <label>
      {label}
      <textarea rows={2} disabled={!open} value={(f[k] as string) ?? ""} onInput={(e) => set(k, (e.target as HTMLTextAreaElement).value)} />
    </label>
  );
  return (
    <section class="section">
      <h2>3. Your facts</h2>
      <div class="paper form">
        <p class="small muted">Only you know these. They go in the listing marked as from you; nothing is assumed.</p>
        <fieldset class="sell-condition">
          <legend>Condition</legend>
          {(
            [
              ["new", "New (sealed or unused)"],
              ["used", "Used"],
              ["parts", "For parts or not working"],
            ] as const
          ).map(([v, label]) => (
            <label class="choice" key={v}>
              <input type="radio" name="condition" disabled={!open} checked={f.condition === v} onChange={() => setF({ ...f, condition: v })} />
              {label}
            </label>
          ))}
          {draft.review && draft.review.condition !== "unknown" && <p class="small muted">From the photos it looks {draft.review.condition === "parts" ? "faulty or incomplete" : draft.review.condition}. You decide.</p>}
        </fieldset>
        {text("works", "Does it work? What did you test?")}
        {text("marks", "Marks, scratches or wear")}
        {text("included", "What's included")}
        {text("missing", "Anything missing")}
        {(draft.review?.questions ?? []).map((q) => (
          <label key={q.id}>
            {q.question} <span class="small muted">{q.why}</span>
            <textarea rows={2} disabled={!open} value={f.answers[q.id] ?? ""} onInput={(e) => setF({ ...f, answers: { ...f.answers, [q.id]: (e.target as HTMLTextAreaElement).value } })} />
          </label>
        ))}
        {text("other", "Anything else a buyer should know")}
        {open && (
          <div class="actions">
            <button class="btn btn-stamp" disabled={busy !== null || !f.condition} onClick={() => onSave(f)}>
              Save facts
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ListingStep(props: { draft: Draft; busy: string | null; onCategory: (id: string) => void; onCompose: () => void; onEdit: (b: unknown) => void }) {
  const { draft, busy } = props;
  const l = draft.listing;
  const open = draft.status === "open";
  const [title, setTitle] = useState(l?.title ?? "");
  const [desc, setDesc] = useState(l?.description ?? "");
  const [addName, setAddName] = useState("");
  const [addValue, setAddValue] = useState("");
  useEffect(() => {
    setTitle(l?.title ?? "");
    setDesc(l?.description ?? "");
  }, [l?.title, l?.description]);
  const missingRequired = (draft.aspects ?? []).filter((a) => a.required && !l?.specifics.some((s) => s.name === a.name));
  const addAspect = (draft.aspects ?? []).find((a) => a.name === addName);
  return (
    <section class="section">
      <h2>4. Category and listing</h2>
      <div class="paper form">
        {draft.categories && draft.categories.length > 0 ? (
          <label>
            Category (eBay's suggestions)
            <select disabled={!open} value={draft.category?.id ?? ""} onChange={(e) => props.onCategory((e.target as HTMLSelectElement).value)}>
              {draft.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.path ? `${c.path} > ` : ""}
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p class="error">eBay suggested no category. Add what it is in your words above, then check the photos again.</p>
        )}
        {open && draft.category && (
          <div class="actions">
            <button class={`btn ${l ? "btn-text" : "btn-stamp"}`} disabled={busy !== null} onClick={props.onCompose}>
              {busy === "compose" ? "Claude is writing it (up to a minute)" : l ? "Write it again" : "Write the listing"}
            </button>
            <span class="small muted">From the photos, your facts and published specs only. About 2 to 5p.</span>
          </div>
        )}
        {l && (
          <>
            <label>
              Title ({title.length}/80)
              <input disabled={!open} value={title} maxLength={80} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} onBlur={() => title !== l.title && props.onEdit({ title })} />
            </label>
            <label>
              Description
              <textarea disabled={!open} rows={8} value={desc} onInput={(e) => setDesc((e.target as HTMLTextAreaElement).value)} onBlur={() => desc !== l.description && props.onEdit({ description: desc })} />
            </label>
            <p class="kind">Item specifics</p>
            <ul class="sell-specifics">
              {l.specifics.map((s) => (
                <li key={s.name}>
                  <strong>{s.name}:</strong> {s.values.join(", ")}{" "}
                  <span class="small muted">({s.source === "photo" ? `photo ${s.ref}` : s.source === "you" ? "from you" : "published spec"})</span>{" "}
                  {open && (
                    <button class="btn-link" onClick={() => props.onEdit({ removeSpecific: s.name })}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {missingRequired.length > 0 && <p class="flag">eBay requires: {missingRequired.map((a) => a.name).join(", ")}. Add them below if you know them.</p>}
            {l.dropped.length > 0 && (
              <details class="small">
                <summary>{l.dropped.length} left out because no source showed them</summary>
                <ul>
                  {l.dropped.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </details>
            )}
            {open && (
              <div class="sell-add">
                <select value={addName} onChange={(e) => (setAddName((e.target as HTMLSelectElement).value), setAddValue(""))} aria-label="Item specific to add">
                  <option value="">Add an item specific (from you)…</option>
                  {(draft.aspects ?? []).map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                      {a.required ? " (required)" : ""}
                    </option>
                  ))}
                </select>
                {addAspect?.selectionOnly ? (
                  <select value={addValue} onChange={(e) => setAddValue((e.target as HTMLSelectElement).value)} aria-label="Value">
                    <option value="">Pick…</option>
                    {addAspect.values.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={addValue} placeholder="Value" onInput={(e) => setAddValue((e.target as HTMLInputElement).value)} aria-label="Value" list={addAspect ? "sell-values" : undefined} />
                )}
                {addAspect && !addAspect.selectionOnly && (
                  <datalist id="sell-values">
                    {addAspect.values.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                )}
                <button class="btn btn-text" disabled={!addName || !addValue.trim()} onClick={() => (props.onEdit({ addSpecific: { name: addName, value: addValue } }), setAddName(""), setAddValue(""))}>
                  Add
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function PriceStep({ draft, busy, onCheck, onChoose }: { draft: Draft; busy: string | null; onCheck: () => void; onChoose: (b: unknown) => void }) {
  const p = draft.pricing;
  const open = draft.status === "open";
  const [own, setOwn] = useState(draft.price?.kind === "own" ? String(draft.price.value) : "");
  const [floor, setFloor] = useState(draft.price?.floor != null ? String(draft.price.floor) : "");
  const [offers, setOffers] = useState(draft.price?.bestOffer ?? true);
  const choose = (value: number | string) => onChoose({ value, floor: floor.trim() === "" ? null : Number(floor), bestOffer: offers });
  const options = p ? [p.options[0], p.price != null ? { price: p.price, daysToSell: p.options[1]?.daysToSell ?? 0 } : null, p.options[2]].filter((o): o is { price: number; daysToSell: number } => Boolean(o)) : [];
  return (
    <section class="section">
      <h2>5. Price</h2>
      <div class="paper form">
        {open && (
          <div class="actions">
            <button class={`btn ${p ? "btn-text" : "btn-stamp"}`} disabled={busy !== null} onClick={onCheck}>
              {busy === "price-check" ? "Checking the market (up to a minute)" : p ? "Check again" : "Price it"}
            </button>
            <span class="small muted">The pricing engine, from real sold listings.</span>
          </div>
        )}
        {p && <p>{p.strategy === "ask" ? <strong>{p.question}</strong> : p.why}</p>}
        {p && p.strategy !== "ask" && options.length > 0 && (
          <div class="actions">
            {options.map((o, i) => (
              <button key={i} class={`btn ${draft.price?.value === o.price ? "btn-stamp" : "btn-ink"}`} disabled={!open || busy !== null} onClick={() => choose(o.price)}>
                {money(o.price)} {o.price === p.price ? "(recommended)" : i === 0 ? "(quicker)" : "(higher)"}
              </button>
            ))}
          </div>
        )}
        {p && p.strategy === "ask" && p.reason === "no_sales" && (
          <div class="sell-own">
            <label>
              Your price, £
              <input inputMode="decimal" disabled={!open} value={own} onInput={(e) => setOwn((e.target as HTMLInputElement).value)} />
            </label>
            <button class="btn btn-stamp" disabled={!open || !own.trim() || busy !== null} onClick={() => choose(own)}>
              Set as your price
            </button>
          </div>
        )}
        {p && (
          <>
            <label>
              Lowest price you'd accept (floor, optional), £
              <input inputMode="decimal" disabled={!open} value={floor} onInput={(e) => setFloor((e.target as HTMLInputElement).value)} />
            </label>
            <label class="choice">
              <input type="checkbox" disabled={!open} checked={offers} onChange={() => setOffers(!offers)} />
              Let buyers make offers (you answer every one)
            </label>
          </>
        )}
        {draft.price && (
          <p class="result">
            Listing at {money(draft.price.value)} ({draft.price.kind === "own" ? "your own price" : "the engine's"}){draft.price.floor != null ? `, floor ${money(draft.price.floor)}` : ""}.
          </p>
        )}
      </div>
    </section>
  );
}

function PostageStep(props: { draft: Draft; busy: string | null; onQuote: (p: unknown) => void; onSave: (b: unknown) => void }) {
  const { draft, busy } = props;
  const open = draft.status === "open";
  const [postcode, setPostcode] = useState(draft.postage?.postcode ?? "");
  const [parcel, setParcel] = useState({
    lengthCm: String(draft.parcel?.lengthCm ?? ""),
    widthCm: String(draft.parcel?.widthCm ?? ""),
    heightCm: String(draft.parcel?.heightCm ?? ""),
    weightKg: String(draft.parcel?.weightKg ?? ""),
  });
  const [cost, setCost] = useState(draft.postage && !draft.postage.collectionOnly ? String(draft.postage.cost) : "");
  const [carrier, setCarrier] = useState<{ carrier: string; service: string } | null>(draft.postage?.carrier ? { carrier: draft.postage.carrier, service: draft.postage.service ?? "" } : null);
  const [collect, setCollect] = useState(draft.postage?.collectionOffered ?? false);
  const [only, setOnly] = useState(draft.postage?.collectionOnly ?? false);
  useEffect(() => {
    if (!postcode) api<{ postcode: string | null }>("/drafts/defaults").then((d) => d.postcode && setPostcode(d.postcode)).catch(() => {});
  }, []);
  const num = (k: keyof typeof parcel, label: string) => (
    <label>
      {label}
      <input inputMode="decimal" disabled={!open} value={parcel[k]} onInput={(e) => setParcel({ ...parcel, [k]: (e.target as HTMLInputElement).value })} />
    </label>
  );
  return (
    <section class="section">
      <h2>6. Postage</h2>
      <div class="paper form">
        <label class="choice">
          <input type="checkbox" disabled={!open} checked={only} onChange={() => setOnly(!only)} />
          Collection only (no postage)
        </label>
        {!only && (
          <>
            <p class="small muted">The packed parcel's size and weight, for live prices from the carriers eBay's Simple Delivery uses (Evri, Royal Mail, DHL, InPost).</p>
            <div class="sell-parcel">
              {num("lengthCm", "Length, cm")}
              {num("widthCm", "Width, cm")}
              {num("heightCm", "Height, cm")}
              {num("weightKg", "Weight, kg")}
            </div>
            {open && (
              <button class="btn btn-text" disabled={busy !== null} onClick={() => props.onQuote(Object.fromEntries(Object.entries(parcel).map(([k, v]) => [k, Number(v)])))}>
                {busy === "quotes" ? "Getting prices" : "Get prices"}
              </button>
            )}
            {draft.quotes?.error && <p class="small sell-issues">{draft.quotes.error}</p>}
            {draft.quotes && draft.quotes.quotes.length > 0 && (
              <ul class="sell-quotes">
                {draft.quotes.quotes.map((q, i) => (
                  <li key={i}>
                    <button class="btn-link" disabled={!open} onClick={() => (setCost(String(Math.ceil(q.price * 2) / 2)), setCarrier({ carrier: q.carrier, service: q.service }))}>
                      {q.carrier} {q.service}: {money(q.price)}
                    </button>
                    {i === 0 && <span class="small muted"> cheapest</span>}
                  </li>
                ))}
              </ul>
            )}
            <label>
              Postage the buyer pays, £ (rounding up is fine: refund any difference)
              <input inputMode="decimal" disabled={!open} value={cost} onInput={(e) => (setCost((e.target as HTMLInputElement).value), setCarrier(null))} />
            </label>
            <label class="choice">
              <input type="checkbox" disabled={!open} checked={collect} onChange={() => setCollect(!collect)} />
              Collection also welcome
            </label>
          </>
        )}
        <label>
          Postcode it's sent from (buyers see the area only)
          <input disabled={!open} value={postcode} maxLength={10} onInput={(e) => setPostcode((e.target as HTMLInputElement).value)} />
        </label>
        {open && (
          <div class="actions">
            <button
              class="btn btn-stamp"
              disabled={busy !== null || !postcode.trim() || (!only && cost.trim() === "")}
              onClick={() =>
                props.onSave({
                  cost: only ? 0 : Number(cost),
                  carrier: carrier?.carrier ?? null,
                  service: carrier?.service ?? null,
                  source: carrier ? "parcel2go" : "you",
                  collectionOffered: collect,
                  collectionOnly: only,
                  postcode,
                  parcel: Object.fromEntries(Object.entries(parcel).map(([k, v]) => [k, Number(v)])),
                })
              }
            >
              Save postage
            </button>
          </div>
        )}
        {draft.postage && (
          <p class="result">
            {draft.postage.collectionOnly ? "Collection only." : `Postage ${money(draft.postage.cost)}${draft.postage.carrier ? ` (${draft.postage.carrier})` : ""}${draft.postage.collectionOffered ? ", collection welcome" : ""}.`} From {draft.postage.postcode}.
          </p>
        )}
      </div>
    </section>
  );
}
