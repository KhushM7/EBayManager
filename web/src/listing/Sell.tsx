import { useEffect, useRef, useState } from "preact/hooks";
import { api, SignedOut } from "../api";
import { ago } from "../format";
import type { ScreenProps } from "../screens";
import { bitsToHex, CHECKLIST, hexToBits, type Issue } from "./checks";
import { processPhoto, type Processed } from "./photos";
import "./listing.css";

// Add Listing, step L1 (docs/add-listing.md): drafts and their photos. The photo checklist, the camera or file
// picker, the phone's instant checks with retake advice, upload, order, and resuming drafts. Nothing here
// touches eBay. The draft is kept in the address (?draft=<id>) so the back button and a reload both work.

interface DraftPhoto {
  id: string;
  url: string;
  width: number;
  height: number;
  issues: string[];
  hash: string | null;
}

interface Draft {
  id: string;
  status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  photos: DraftPhoto[];
}

const ISSUE_WORD: Record<string, string> = { small: "Small", dark: "Dark", bright: "Too bright", blur: "Blurry", duplicate: "Same as another" };
const MAX_PHOTOS = 24;

const draftParam = () => new URLSearchParams(location.search).get("draft");
function openDraft(id: string | null) {
  history.pushState(null, "", id ? `/sell?draft=${encodeURIComponent(id)}` : "/sell");
  dispatchEvent(new PopStateEvent("popstate"));
}

/** Sends one prepared photo; the server checks it again and strips metadata a second time. */
async function upload(draftId: string, p: Processed): Promise<Draft> {
  const q = new URLSearchParams({ hash: bitsToHex(p.hash) });
  if (p.issues.length) q.set("issues", p.issues.map((i) => i.code).join(","));
  const res = await fetch(`/api/drafts/${draftId}/photos?${q}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "image/jpeg", "X-EbayManager": "1" },
    body: p.blob,
  });
  if (res.status === 401) throw new SignedOut();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `Upload failed (${res.status})`);
  return data as Draft;
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

function Drafts({ onSignedOut }: ScreenProps) {
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => (e instanceof SignedOut ? onSignedOut() : setError((e as Error).message));
  useEffect(() => {
    api<Draft[]>("/drafts").then(setRows).catch(fail);
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
          <ol class="sell-drafts">
            {rows.map((d) => (
              <li key={d.id}>
                <a
                  class="sell-draft paper"
                  href={`/sell?draft=${d.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    openDraft(d.id);
                  }}
                >
                  {d.photos[0] ? <img src={d.photos[0].url} alt="" loading="lazy" /> : <span class="sell-noimg" aria-hidden="true" />}
                  <span>
                    <strong>{d.title || "Untitled"}</strong>
                    <span class="small muted">
                      {d.photos.length} photo{d.photos.length === 1 ? "" : "s"} · {d.created_by} · changed {ago(d.updated_at)}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ol>
          <p class="small muted">Drafts nobody touches for 30 days are deleted, with their photos.</p>
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

function DraftView({ id, onSignedOut }: ScreenProps & { id: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;

  const fail = (e: unknown) => (e instanceof SignedOut ? onSignedOut() : setError((e as Error).message));
  const take = (d: Draft) => (setDraft(d), setTitle(d.title ?? ""));
  useEffect(() => {
    api<Draft>(`/drafts/${id}`)
      .then(take)
      .catch(fail);
  }, [id]);

  const update = (key: string, patch: Partial<Pending>) => setPending((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const drop = (key: string) => setPending((ps) => ps.filter((p) => p.key !== key));

  const send = async (p: Pending) => {
    update(p.key, { state: "uploading" });
    try {
      setDraft(await upload(id, p.processed!));
      drop(p.key);
    } catch (e) {
      if (e instanceof SignedOut) return onSignedOut();
      update(p.key, { state: "error", error: (e as Error).message });
    }
  };

  // Each new photo is checked on the phone; a good one uploads at once, one with issues waits for K.
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
        const next = { ...item, processed };
        if (processed.issues.length) update(item.key, { processed, state: "review" });
        else await send(next);
      } catch (e) {
        update(item.key, { state: "error", error: (e as Error).message || "That file couldn't be read as a photo." });
      }
    }
  };

  const saveTitle = async () => {
    if (!draft || (draft.title ?? "") === title.trim()) return;
    try {
      take(await api<Draft>(`/drafts/${id}`, { body: { title } }));
    } catch (e) {
      fail(e);
    }
  };

  const move = async (photoId: string, by: number) => {
    if (!draft) return;
    const order = draft.photos.map((p) => p.id);
    const i = order.indexOf(photoId);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    try {
      setDraft(await api<Draft>(`/drafts/${id}/order`, { body: { order } }));
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (photoId: string) => {
    try {
      setDraft(await api<Draft>(`/drafts/${id}/photos/${photoId}`, { body: {} }));
    } catch (e) {
      fail(e);
    }
  };

  const deleteDraft = async () => {
    if (!confirmDelete) return setConfirmDelete(true);
    try {
      await api(`/drafts/${id}/delete`, { body: {} });
      openDraft(null);
    } catch (e) {
      fail(e);
    }
  };

  if (!draft)
    return (
      <>
        <BackLink />
        {error ? <p class="error">{error}</p> : <div class="page-head" aria-busy="true" />}
      </>
    );

  const count = draft.photos.length;
  return (
    <>
      <BackLink />
      <div class="page-head">
        <h1 class="title-in">{draft.title || "New listing"}</h1>
        <p>
          {count ? `${count} of ${MAX_PHOTOS} photos.` : "No photos yet."} Started by {draft.created_by} {ago(draft.created_at)}.
        </p>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      <section class="paper sell-what">
        <label class="form">
          What is it, in your words? (optional; the photos come first)
          <input value={title} maxLength={120} placeholder="e.g. Dyson vacuum, needs a new hose" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} onBlur={saveTitle} />
        </label>
      </section>

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

      <section class="section">
        <h2>Photos</h2>
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
        <p class="small muted">Photos are shrunk and their location data removed on this device before they're uploaded. Only the three of you can see them.</p>

        {pending.length > 0 && (
          <ul class="sell-pending">
            {pending.map((p) => (
              <PendingCard
                key={p.key}
                p={p}
                onKeep={() => send(p)}
                onRetake={() => (drop(p.key), camera.current?.click())}
                onDiscard={() => drop(p.key)}
              />
            ))}
          </ul>
        )}

        {count > 0 && (
          <ol class="sell-grid">
            {draft.photos.map((ph, i) => (
              <li key={ph.id} class="sell-photo paper">
                <img src={ph.url} alt={`Photo ${i + 1}`} loading="lazy" />
                <div class="sell-photo-meta">
                  {i === 0 && <span class="state state-info">Main photo</span>}
                  {ph.issues.map((code) => (
                    <span class="state state-held" key={code}>
                      {ISSUE_WORD[code] ?? code}
                    </span>
                  ))}
                </div>
                <div class="sell-photo-actions">
                  <button class="btn-link" disabled={i === 0} onClick={() => move(ph.id, -1)} aria-label={`Move photo ${i + 1} earlier`}>
                    ← Earlier
                  </button>
                  <button class="btn-link" disabled={i === count - 1} onClick={() => move(ph.id, 1)} aria-label={`Move photo ${i + 1} later`}>
                    Later →
                  </button>
                  <button class="btn-link" onClick={() => remove(ph.id)} aria-label={`Remove photo ${i + 1}`}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section class="section paper">
        <h2>Next</h2>
        <p>Claude checks the photos for missing shots, works out what the item is, and asks only what you alone know. That's the next part to be built.</p>
        <button class="btn btn-text" onClick={deleteDraft}>
          {confirmDelete ? "Tap again to delete this draft and its photos" : "Delete draft"}
        </button>
      </section>
    </>
  );
}

function BackLink() {
  return (
    <p>
      <a
        class="btn-link"
        href="/sell"
        onClick={(e) => {
          e.preventDefault();
          openDraft(null);
        }}
      >
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
