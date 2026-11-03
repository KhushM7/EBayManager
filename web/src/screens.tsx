import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Activity as Row, type Device, type Listing, type Me, type Proposal } from "./api";
import { DraftEditor, EDITABLE } from "./drafts";
import { ago, daysSince, describe, money } from "./format";
import { addPasskey } from "./passkey";
import { SoldDataCard } from "./solddata";
import { BundleAdvice, PriceCheck } from "./pricing";

export interface ScreenProps {
  me: Me;
  reloadMe: () => void;
  onSignedOut: () => void;
  go: (path: string) => void;
  /** Something changed that affects the Inbox count. */
  onChanged: () => void;
}

/** Loads one API path, reloadable; a lost session sends the person to sign-in. */
function useData<T>(path: string, onSignedOut: () => void) {
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (n: number) => "$" + (n ?? 0).toFixed(2);

const KIND: Record<string, string> = {
  price: "Price change",
  revise: "Listing edit",
  create_listing: "New listing",
  message: "Reply to a buyer",
  best_offer_response: "Answer an offer",
  end_listing: "End listing",
  relist: "Relist",
  promote: "Promotion",
  policy: "Return policy",
};

const STATE: Record<string, [string, string]> = {
  pending: ["state-decide", "To decide"],
  approved: ["state-held", "Approved, held"],
  applying: ["state-held", "Sending"],
  applied: ["state-applied", "Applied"],
  rejected: ["state-off", "Rejected"],
  expired: ["state-off", "Expired"],
  failed: ["state-decide", "eBay refused it"],
};

// ---------------------------------------------------------------- Inbox

const STATUSES = [
  { id: "pending", label: "To decide" },
  { id: "applied", label: "Applied" },
  { id: "rejected", label: "Rejected" },
  { id: "failed", label: "Refused by eBay" },
  { id: "expired", label: "Expired" },
];

const hasFigure = (p: Proposal) => ["price", "best_offer_response", "create_listing", "promote"].includes(p.kind) || (p.kind === "revise" && Boolean(p.payload?.title));

/** The big line on a label: what changes, old struck through, new in full. */
function Change({ p }: { p: Proposal }) {
  const a = p.payload ?? {};
  if (p.kind === "price")
    return (
      <p class="change">
        {a.oldPrice != null && <span class="was">{money(a.oldPrice)}</span>}
        {money(a.newPrice)}
      </p>
    );
  if (p.kind === "best_offer_response")
    return (
      <p class="change">
        <span class="was">{money(a.offerPrice)}</span>
        {a.action === "counter" ? money(a.counterPrice) : a.action === "accept" ? "Accept" : "Decline"}
      </p>
    );
  if (p.kind === "create_listing") return <p class="change">{money(a.price)}</p>;
  if (p.kind === "promote")
    return (
      <p class="change">
        {a.currentRate != null && <span class="was">{a.currentRate}%</span>}
        {a.action === "end" ? "End ad" : `${a.rate}% ad rate`}
      </p>
    );
  if (p.kind === "revise" && a.title) return <p class="change" style={{ fontSize: "var(--step-lead)" }}>{a.title}</p>;
  return null;
}

export function Inbox({ me, onSignedOut, onChanged }: ScreenProps) {
  const [status, setStatus] = useState("pending");
  const { data, error, reload } = useData<Proposal[]>(`/proposals?status=${status}`, onSignedOut);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => setSelected(new Set()), [status]);

  const decide = async (ids: string[], decision: "approve" | "reject") => {
    setBusy(true);
    try {
      const { results: out } = await api<{ results: { id: string; result: string }[] }>("/proposals/decide", { body: { ids, decision } });
      setResults((r) => ({ ...r, ...Object.fromEntries(out.map((x) => [x.id, x.result])) }));
      setSelected(new Set());
      setTimeout(() => (reload(), onChanged()), 1200);
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setResults((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, (e as Error).message])) }));
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

  const rows = data ?? [];
  const waiting = status === "pending";
  return (
    <>
      <div class="page-head">
        <h1 class="title-in">{waiting && data ? (rows.length ? `${rows.length} to decide` : "All clear") : "Inbox"}</h1>
        {waiting && <p>Each label is a change waiting for one of you. Nothing reaches eBay until it's stamped.</p>}
      </div>
      {waiting && me.writesBlocked && (
        <p class="paper" style={{ marginBottom: "16px" }}>
          <span class="state state-held">Held</span> Approved changes wait for now: {me.writesBlocked.toLowerCase()}.
        </p>
      )}
      {waiting && <BundleAdvice onSignedOut={onSignedOut} />}
      <div class="tabs" role="tablist">
        {STATUSES.map((s) => (
          <button role="tab" aria-selected={s.id === status} class="tab" onClick={() => setStatus(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      {error && <p class="error">{error}</p>}
      {data && !rows.length && (
        <p class="paper">{waiting ? "When Claude proposes a change, its label appears here and on your phone." : "None yet."}</p>
      )}
      <ol class="labels">
        {rows.map((p, i) => {
          const { what } = describe(p);
          const done = results[p.id];
          const [stateClass, stateWord] = STATE[p.status] ?? ["state-info", p.status];
          return (
            <li class="label paper" style={{ "--i": Math.min(i, 10) }} key={p.id}>
              <div class="label-body">
                {/* The change itself leads; what it is and which item follow as plain text. */}
                {hasFigure(p) ? <Change p={p} /> : <h3 class="kind">{KIND[p.kind] ?? what}</h3>}
                <p class="item-title">
                  {hasFigure(p) && `${KIND[p.kind] ?? what}: `}
                  {p.kind === "revise" ? `now "${p.item_title ?? ""}"` : p.item_title ?? p.payload?.itemTitle ?? (p.kind === "create_listing" ? p.payload?.title : "")}
                </p>
                {(!waiting || Boolean(p.dry_run)) && <p class={`state ${stateClass}`}>{p.dry_run ? "Dry run" : stateWord}</p>}
                {EDITABLE.includes(p.kind) && waiting && !done ? (
                  <DraftEditor p={p} onSaved={reload} onSignedOut={onSignedOut} />
                ) : (
                  p.kind === "message" && p.payload?.body && <p class="quote">{p.payload.body}</p>
                )}
                {p.kind === "revise" && p.payload?.itemSpecifics && (
                  <p class="evidence small">
                    Item specifics:{" "}
                    {Object.entries(p.payload.itemSpecifics)
                      .map(([k, v]) => `${k}: ${[v].flat().join(", ")}`)
                      .join("; ")}
                  </p>
                )}
                {p.reason && p.kind !== "message" && <p>{p.reason}</p>}
                {p.kind === "promote" && (
                  <p class="evidence small">
                    {p.payload?.campaign}. eBay suggests {p.payload?.suggestedRate != null ? `${p.payload.suggestedRate}%` : "no rate"}
                    {p.payload?.payback
                      ? `; expected sale in about ${p.payload.payback.daysPromoted} days instead of ${p.payload.payback.daysNow}, ad fee ${money(p.payload.payback.adFee)} if it sells through the ad.`
                      : "."}
                  </p>
                )}
                {p.kind === "policy" && p.payload?.proposed && (
                  <p class="evidence small">
                    {p.payload.name}: returns accepted within {p.payload.proposed.periodDays} days, buyer pays return postage.
                  </p>
                )}
                {(p.payload?.flags ?? []).map((f: string) => (
                  <p class="flag">Check: {f}</p>
                ))}
                <p class="small muted">
                  {waiting ? `Proposed ${ago(p.created_at)}, expires ${ago(p.expires_at)}` : `${stateWord} ${ago(p.decided_at ?? p.created_at)}`}
                  {p.decided_by ? ` by ${p.decided_by}` : ""}
                  {p.item_id ? ` · item ${p.item_id}` : ""}
                </p>
                {!waiting && p.result && <p class="small">{p.result}</p>}
              </div>
              {waiting && (
                <div class="label-stub">
                  {done ? (
                    <p class="result" role="status">{done}</p>
                  ) : p.dry_run ? (
                    <p class="small">Dry run: proposed while changes are off, so it can't be applied.</p>
                  ) : (
                    <>
                      <label class="choice small">
                        <input type="checkbox" class="pick" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                        Select
                      </label>
                      <button class="btn btn-stamp" disabled={busy} onClick={() => decide([p.id], "approve")}>
                        Approve
                      </button>
                      <button class="btn btn-text" disabled={busy} onClick={() => decide([p.id], "reject")}>
                        Reject
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {selected.size > 0 && (
        <div class="batch" role="region" aria-label="Selected changes">
          <span>{plural(selected.size, "label")} selected</span>
          <button class="btn btn-stamp" disabled={busy} onClick={() => decide([...selected], "approve")}>
            Approve {selected.size}
          </button>
          <button class="btn btn-text" disabled={busy} onClick={() => decide([...selected], "reject")}>
            Reject
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Desktop summary (and its phone equivalent)

export function Aside({ me, go, waiting, onSignedOut, here }: ScreenProps & { waiting: number; here: string }) {
  const usage = useData<{ today: { usd: number }; dailyBudgetUsd: number; apiKeySet: boolean }>("/usage", onSignedOut);
  return (
    <>
      <div class="paper">
        <p class="kind">Waiting</p>
        <p class="receipt-total">{waiting}</p>
        <p>{waiting ? `${plural(waiting, "change")} to decide.` : "Nothing to decide."}</p>
        {waiting > 0 && here !== "/" && (
          <button class="btn btn-stamp" style={{ width: "100%" }} onClick={() => go("/")}>
            Open the Inbox
          </button>
        )}
        <div class="receipt-tear">
          <dl class="figures">
            <div>
              <dt>Account</dt>
              <dd>{me.ebayEnv === "production" ? "Real" : "Sandbox"}</dd>
            </div>
            <div>
              <dt>Changes</dt>
              <dd>{me.writesPaused ? "Paused" : me.writesBlocked ? "Off" : "On, after approval"}</dd>
            </div>
            <div>
              <dt>Claude today</dt>
              <dd>{usage.data ? `${usd(usage.data.today.usd)} of ${usd(usage.data.dailyBudgetUsd)}` : "…"}</dd>
            </div>
            <div>
              <dt>Last notification</dt>
              <dd>{ago(me.lastPushAt)}</dd>
            </div>
          </dl>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Listings

export function Listings({ me, onSignedOut, onChanged }: ScreenProps) {
  const { data, error, reload } = useData<Listing[]>("/listings", onSignedOut);
  const [refreshing, setRefreshing] = useState(false);
  const [reviews, setReviews] = useState<Record<string, { busy?: boolean; note?: string; error?: string }>>({});

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

  const review = async (itemId: string) => {
    setReviews((r) => ({ ...r, [itemId]: { busy: true } }));
    try {
      const out = await api<{ note: string; costUsd: number }>("/audit", { body: { itemId } });
      setReviews((r) => ({ ...r, [itemId]: { note: `${out.note || "Done."} (cost ${out.costUsd < 0.01 ? "under 1 cent" : usd(out.costUsd)})` } }));
      reload();
      onChanged();
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setReviews((r) => ({ ...r, [itemId]: { error: (e as Error).message } }));
    }
  };

  const rows = data ?? [];
  const total = rows.reduce((s, l) => s + Number(l.price) * Number(l.quantity_available || 1), 0);
  return (
    <>
      <div class="page-head">
        <h1 class="title-in">{data ? plural(rows.length, "listing") : "Listings"}</h1>
        {data && rows.length > 0 && (
          <p>
            <span class="money">{money(total)}</span> asked in total. Read from eBay {ago(rows[0].taken_at)}.{" "}
            <button class="btn-link" onClick={refresh} disabled={refreshing}>
              {refreshing ? "Reading eBay" : "Read again"}
            </button>
          </p>
        )}
      </div>
      {error && <p class="error">{error}</p>}
      {data && !rows.length && (
        <p class="paper">
          No listings read yet.{" "}
          <button class="btn-link" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Reading eBay" : "Read them from eBay"}
          </button>
        </p>
      )}
      <ol class="bars">
        {rows.map((l, i) => (
          <li class="bar" style={{ "--i": Math.min(i, 12) }} key={l.item_id}>
            <span class="item-title" style={{ margin: 0 }}>
              {l.title}
            </span>
            <span class="money">{money(l.price)}</span>
            <p class="wide" style={{ margin: 0 }}>
              {[
                plural(daysSince(l.start_time), "day") + " listed",
                plural(l.watch_count ?? 0, "watcher"),
                l.floor_price != null && `floor ${money(l.floor_price)}`,
                l.collection_only ? "collection only" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              <span class="muted small"> · item {l.item_id}</span>
            </p>
            {l.pending > 0 && <p class="wide flag" style={{ margin: 0 }}>{plural(l.pending, "label")} waiting in the Inbox</p>}
            {reviews[l.item_id]?.note && <p class="wide result">{reviews[l.item_id].note}</p>}
            {reviews[l.item_id]?.error && <p class="wide error">{reviews[l.item_id].error}</p>}
            <div class="wide" style={{ margin: "6px 0 0" }}>
              <button class="btn-link" disabled={reviews[l.item_id]?.busy} onClick={() => review(l.item_id)}>
                {reviews[l.item_id]?.busy ? "Claude is reviewing (up to a minute)" : "Review with Claude"}
              </button>
              {me.user.role === "owner" && (
                <>
                  {" · "}
                  <PriceCheck itemId={l.item_id} onSignedOut={onSignedOut} />
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

// ---------------------------------------------------------------- Activity

const OUTCOME: Record<Row["outcome"], [string, string]> = {
  applied: ["state-applied", "Applied"],
  refused: ["state-held", "Refused by the write gate"],
  failed: ["state-decide", "eBay refused it"],
};

export function Activity({ onSignedOut }: ScreenProps) {
  const { data, error } = useData<Row[]>("/activity", onSignedOut);
  const rows = data ?? [];
  return (
    <>
      <div class="page-head">
        <h1 class="title-in">Activity</h1>
        <p>Every change sent to eBay, who approved it, and every attempt the write gate refused.</p>
      </div>
      {error && <p class="error">{error}</p>}
      <div class="paper">
        {data && !rows.length && <p>Nothing has been sent yet.</p>}
        <ol class="bars">
          {rows.map((a, i) => {
            const [cls, word] = OUTCOME[a.outcome] ?? ["state-info", a.outcome];
            return (
              <li class="bar" style={{ "--i": Math.min(i, 12), background: i % 2 ? "var(--paper)" : "var(--paper-2)" }} key={a.id}>
                <span class={`state ${cls}`}>{word}</span>
                <span class="muted small">{ago(a.at)}</span>
                <p class="wide" style={{ margin: 0 }}>
                  {KIND[a.kind ?? ""] ?? a.call}
                  {a.item_id ? `, item ${a.item_id}` : ""}
                  {a.actor ? `, approved by ${a.actor}` : ""}
                </p>
                {a.outcome !== "applied" && a.response && <p class="wide muted small" style={{ margin: 0 }}>{a.response}</p>}
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings

interface Usage {
  today: { usd: number; calls: number };
  month: { usd: number; calls: number };
  byJob: { job: string; calls: number; usd: number }[];
  dailyBudgetUsd: number;
  apiKeySet: boolean;
}

interface People {
  people: { id: string; name: string; role: string; created_at: number; passkeys: { id: string; label: string; last_used_at: number | null }[] }[];
  invites: { name: string; expires_at: number }[];
  max: number;
}

const JOB_NAMES: Record<string, string> = { audit: "Listing reviews", triage: "Nightly checks", reply: "Reply drafts", offer: "Offer suggestions" };

const keyBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function deviceName(ua: string | null) {
  if (!ua) return "A device";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "A device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os}, ${browser}` : os;
}

function PeopleCard({ me, onSignedOut }: ScreenProps) {
  const people = useData<People>("/people", onSignedOut);
  const [name, setName] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invite = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      const out = await api<{ inviteUrl: string }>("/people/invite", { body: { name } });
      setLink(out.inviteUrl);
      setName("");
      people.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const act = async (id: string, what: "remove" | "signout") => {
    setError(null);
    try {
      await api(`/people/${id}/${what}`, { body: {} });
      people.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const d = people.data;
  const room = d ? d.max - d.people.length - d.invites.length : 0;
  return (
    <section class="paper">
      <h2>People</h2>
      <p>Up to three people can use EBayManager: you and two managers. Each signs in with their own passkey.</p>
      {d && (
        <ol class="bars">
          {d.people.map((p) => (
            <li class="bar" style={{ background: "var(--paper-2)" }} key={p.id}>
              <span class="item-title" style={{ margin: 0 }}>
                {p.name} <span class="muted small">({p.role})</span>
              </span>
              <span class="small muted">{plural(p.passkeys.length, "passkey")}</span>
              <p class="wide small" style={{ margin: 0 }}>
                {p.passkeys.map((k) => `${k.label}, last used ${ago(k.last_used_at)}`).join(" · ") || "No passkeys"}
              </p>
              <p class="wide" style={{ margin: "6px 0 0" }}>
                <button class="btn-link" onClick={() => act(p.id, "signout")}>
                  Sign out everywhere
                </button>
                {p.id !== me.user.id && (
                  <>
                    {"  ·  "}
                    <button class="btn-link" onClick={() => act(p.id, "remove")}>
                      Remove {p.name}
                    </button>
                  </>
                )}
              </p>
            </li>
          ))}
          {d.invites.map((v) => (
            <li class="bar" style={{ background: "var(--paper-2)" }} key={v.name + v.expires_at}>
              <span>{v.name}</span>
              <span class="state state-held">Invited</span>
              <p class="wide small muted" style={{ margin: 0 }}>
                Invite expires {ago(v.expires_at)}
              </p>
            </li>
          ))}
        </ol>
      )}
      {room > 0 && (
        <form class="form" onSubmit={invite}>
          <label for="invite-name">Invite a manager</label>
          <input id="invite-name" value={name} maxLength={60} placeholder="Their name" onInput={(e) => setName(e.currentTarget.value)} required />
          <div class="actions" style={{ marginTop: 0 }}>
            <button class="btn btn-ink">Create invite link</button>
          </div>
        </form>
      )}
      {link && (
        <div class="evidence">
          <p>
            Send this link to them privately (not in a group chat). It works once and expires in 24 hours. It won't be shown again.
          </p>
          <p style={{ overflowWrap: "anywhere", fontWeight: 600 }}>{link}</p>
          <button class="btn btn-quiet" onClick={() => navigator.clipboard?.writeText(link)}>
            Copy link
          </button>
        </div>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}

export function Settings(props: ScreenProps) {
  const { me, reloadMe, onSignedOut } = props;
  const devices = useData<Device[]>("/push/devices", onSignedOut);
  const usage = useData<Usage>("/usage", onSignedOut);
  const [note, setNote] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const owner = me.user.role === "owner";

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setNote(null);
    try {
      const msg = await fn();
      if (msg) setNote(msg);
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enablePush = () =>
    run(async () => {
      if (!me.vapidPublicKey) return "Notifications aren't set up on the server yet.";
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return "Notifications are blocked for this site. Allow them in the browser's site settings.";
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(me.vapidPublicKey) }));
      await api("/push/subscribe", { body: { subscription: sub.toJSON() } });
      await devices.reload();
      return "This device will now get notifications.";
    });

  return (
    <>
      <div class="page-head">
        <h1 class="title-in">Settings</h1>
        <p>
          Signed in as <strong>{me.user.name}</strong> ({me.user.role}).
        </p>
      </div>
      <div class="settings">
        <section class="paper">
          <h2>Changes</h2>
          <dl class="figures">
            <div>
              <dt>eBay account</dt>
              <dd>{me.ebayEnv === "production" ? "Your real account" : "Sandbox test account"}</dd>
            </div>
            <div>
              <dt>Signed in to eBay with</dt>
              <dd>{me.ebayConnected ? (me.ebayScopes === "read-only" ? "Read-only permissions" : "Full permissions") : "Not connected"}</dd>
            </div>
            <div>
              <dt>Changes to eBay</dt>
              <dd>{me.writeMode !== "approval" ? "Off: read-only" : me.writesPaused ? "Paused" : "Applied after approval"}</dd>
            </div>
          </dl>
          {me.writeMode === "approval" && (
            <div class="actions">
              {me.writesPaused ? (
                owner ? (
                  <button class="btn btn-stamp" disabled={busy} onClick={() => run(async () => (await api("/settings/writes", { body: { paused: false } }), reloadMe()))}>
                    Resume changes
                  </button>
                ) : (
                  <p class="small">Only the owner can resume changes.</p>
                )
              ) : (
                <button class="btn btn-ink" disabled={busy} onClick={() => run(async () => (await api("/settings/writes", { body: { paused: true } }), reloadMe()))}>
                  Pause all changes
                </button>
              )}
            </div>
          )}
          <p class="small muted" style={{ marginTop: "12px" }}>
            Anyone can pause. Approvals made while paused wait until the owner resumes.
          </p>
          {owner && !me.ebayConnected && (
            <p>
              <a href="/oauth/start">Connect the eBay account</a>
            </p>
          )}
        </section>

        <section class="paper">
          <h2>Notifications</h2>
          <dl class="figures">
            <div>
              <dt>This device</dt>
              <dd>{permission === "granted" ? "Allowed" : permission === "denied" ? "Blocked" : permission === "unsupported" ? "Not supported" : "Not turned on"}</dd>
            </div>
            <div>
              <dt>Last delivered</dt>
              <dd>{ago(me.lastPushAt)}</dd>
            </div>
          </dl>
          <div class="actions">
            {permission !== "unsupported" && (
              <button class="btn btn-ink" disabled={busy} onClick={enablePush}>
                Turn on for this device
              </button>
            )}
            <button
              class="btn btn-text"
              disabled={busy || !(devices.data ?? []).length}
              onClick={() => run(async () => (await api("/push/test", { body: {} }), reloadMe(), "Sent. It should arrive within a few seconds."))}
            >
              Send a test
            </button>
          </div>
          {(devices.data ?? []).length > 0 && (
            <ol class="bars" style={{ marginTop: "14px" }}>
              {devices.data!.map((d) => (
                <li class="bar" style={{ background: "var(--paper-2)" }} key={d.endpoint}>
                  <span>{deviceName(d.user_agent)}</span>
                  <button
                    class="btn-link"
                    onClick={() => run(async () => (await api("/push/unsubscribe", { body: { endpoint: d.endpoint } }), await devices.reload()))}
                  >
                    Remove
                  </button>
                  <p class="wide small muted" style={{ margin: 0 }}>
                    Added {ago(d.created_at)}
                    {d.last_error ? ` · last error: ${d.last_error}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <p class="small muted" style={{ marginTop: "12px" }}>
            On Android: open this site in Chrome, choose Install app, then turn notifications on here. To have them pop up, long-press a notification,
            choose Settings, and set it to Alert with Show as pop-up.
          </p>
        </section>

        <section class="paper">
          <h2>Your passkeys</h2>
          <p>Add a passkey on each phone or computer you use. Adding one gives you a fresh set of recovery codes.</p>
          {codes ? (
            <div class="evidence">
              <p>New recovery codes. Save them now; they replace your old ones and won't be shown again.</p>
              <ol class="codes">
                {codes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ol>
            </div>
          ) : (
            <div class="actions">
              <button class="btn btn-ink" disabled={busy} onClick={() => run(async () => setCodes(await addPasskey()))}>
                Add a passkey on this device
              </button>
            </div>
          )}
        </section>

        {owner && (
          <div class="span">
            <PeopleCard {...props} />
          </div>
        )}

        <SoldDataCard owner={owner} onSignedOut={onSignedOut} />

        <section class="paper">
          <h2>Claude</h2>
          {usage.data && (
            <dl class="figures">
              <div>
                <dt>API key</dt>
                <dd>{usage.data.apiKeySet ? "Set" : "Not set yet"}</dd>
              </div>
              <div>
                <dt>Today</dt>
                <dd>
                  {usd(usage.data.today.usd)} of {usd(usage.data.dailyBudgetUsd)}
                </dd>
              </div>
              <div>
                <dt>This month</dt>
                <dd>
                  {usd(usage.data.month.usd)} over {plural(usage.data.month.calls, "call")}
                </dd>
              </div>
              {usage.data.byJob.map((j) => (
                <div key={j.job}>
                  <dt>{JOB_NAMES[j.job] ?? j.job}</dt>
                  <dd>{usd(j.usd)}</dd>
                </div>
              ))}
            </dl>
          )}
          <p class="small muted" style={{ marginTop: "12px" }}>
            Claude only reads and proposes. Runs stop for the day once the budget is reached.
          </p>
        </section>

        {note && (
          <p class="paper result span" role="status">
            {note}
          </p>
        )}

        <section class="span">
          <button class="btn btn-quiet" onClick={() => run(async () => (await api("/logout", { body: {} }), onSignedOut()))}>
            Sign out of this device
          </button>
        </section>
      </div>
    </>
  );
}
