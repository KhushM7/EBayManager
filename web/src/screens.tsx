import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Activity as Row, type Device, type Listing, type Me, type Proposal } from "./api";
import { ago, daysSince, describe, money } from "./format";

interface ScreenProps {
  me: Me;
  reloadMe: () => void;
  onSignedOut: () => void;
}

/** Loads one API path, reloadable; a lost session sends K to sign-in. */
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

// ---------------------------------------------------------------- Sign in

export function SignIn({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/login", { body: { key } });
      onDone();
    } catch (err) {
      setError((err as Error).message === "Wrong key" ? "That key didn't match." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="column signin">
      <h1 class="rise">Sign in to EBayManager</h1>
      <p>Nothing changes on your eBay account until you approve it here or from a notification.</p>
      <form onSubmit={submit} class="form">
        <label for="key">Dashboard key</label>
        <input id="key" type="password" autocomplete="current-password" value={key} onInput={(e) => setKey(e.currentTarget.value)} required />
        {error && <p class="error" role="alert">{error}</p>}
        <button class="btn btn-primary" disabled={busy || !key}>
          {busy ? "Signing in" : "Sign in"}
        </button>
      </form>
      <p class="muted small">Your key is DASHBOARD_KEY in the project's .dev.vars file.</p>
    </main>
  );
}

// ---------------------------------------------------------------- Inbox

const STATUSES = [
  { id: "pending", label: "Waiting" },
  { id: "applied", label: "Applied" },
  { id: "rejected", label: "Rejected" },
  { id: "failed", label: "Failed" },
  { id: "expired", label: "Expired" },
];

export function Inbox({ me, onSignedOut }: ScreenProps) {
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
      setTimeout(reload, 1200);
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
      <h1 class="rise">
        {waiting ? (data ? (rows.length ? `${plural(rows.length, "change")} waiting for you` : "Nothing is waiting") : "Inbox") : "Inbox"}
      </h1>
      {waiting && me.writesBlocked && <p class="notice">Approved changes are held for now: {me.writesBlocked.toLowerCase()}.</p>}
      <div class="tabs" role="tablist">
        {STATUSES.map((s) => (
          <button role="tab" aria-selected={s.id === status} class="tab" onClick={() => setStatus(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      {error && <p class="error">{error}</p>}
      {data && !rows.length && (
        <p class="muted">{waiting ? "When Claude proposes a change, it appears here and on your phone." : "None yet."}</p>
      )}
      <ol class="rows">
        {rows.map((p, i) => {
          const { what, figure } = describe(p);
          const done = results[p.id];
          return (
            <li class="row proposal" style={{ "--i": i }} key={p.id}>
              {waiting && !p.dry_run && (
                <input
                  type="checkbox"
                  class="pick"
                  aria-label={`Select: ${what}`}
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                />
              )}
              <div class="row-main">
                <div class="row-ends">
                  <span class="row-title">{what}</span>
                  {figure && <span class="row-figure">{figure}</span>}
                </div>
                {p.item_title && p.kind !== "create_listing" && <p class="muted">{p.item_title}</p>}
                {p.reason && <p>{p.reason}</p>}
                {(p.payload?.flags ?? []).map((f: string) => (
                  <p class="flag">Check: {f}</p>
                ))}
                {p.payload?.verifiedFees != null && <p class="muted small">eBay checked this listing. Listing fee {money(p.payload.verifiedFees)}.</p>}
                <p class="muted small">
                  {waiting ? `Proposed ${ago(p.created_at)}, expires ${ago(p.expires_at)}` : `${p.status} ${ago(p.decided_at ?? p.created_at)}`}
                  {p.item_id ? ` · item ${p.item_id}` : ""}
                </p>
                {!waiting && p.result && <p class="muted small">{p.result}</p>}
                {done ? (
                  <p class="result" role="status">{done}</p>
                ) : waiting && p.dry_run ? (
                  <p class="muted">Dry run: proposed while writes are off, so it can't be applied.</p>
                ) : waiting ? (
                  <div class="actions">
                    <button class="btn btn-primary" disabled={busy} onClick={() => decide([p.id], "approve")}>
                      Approve
                    </button>
                    <button class="btn btn-text" disabled={busy} onClick={() => decide([p.id], "reject")}>
                      Reject
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {selected.size > 0 && (
        <div class="batch" role="region" aria-label="Selected changes">
          <span>{plural(selected.size, "change")} selected</span>
          <button class="btn btn-primary" disabled={busy} onClick={() => decide([...selected], "approve")}>
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

// ---------------------------------------------------------------- Listings

export function Listings({ onSignedOut }: ScreenProps) {
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
  return (
    <>
      <h1 class="rise">{data ? plural(rows.length, "listing") : "Listings"}</h1>
      {data && rows.length > 0 && (
        <p>
          Asking {money(total)} in total. Read from eBay {ago(rows[0].taken_at)}.{" "}
          <button class="btn-link" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Reading eBay" : "Read again"}
          </button>
        </p>
      )}
      {error && <p class="error">{error}</p>}
      {data && !rows.length && (
        <p>
          No listings read yet.{" "}
          <button class="btn-link" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Reading eBay" : "Read them from eBay"}
          </button>
        </p>
      )}
      <ol class="rows">
        {rows.map((l, i) => (
          <li class="row" style={{ "--i": i }} key={l.item_id}>
            <div class="row-main">
              <div class="row-ends">
                <span class="row-title">{l.title}</span>
                <span class="row-figure">{money(l.price)}</span>
              </div>
              <p class="meta">
                {[
                  plural(daysSince(l.start_time), "day") + " listed",
                  plural(l.watch_count ?? 0, "watcher"),
                  l.floor_price != null && `floor ${money(l.floor_price)}`,
                  l.collection_only ? "collection only" : null,
                  `item ${l.item_id}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {l.pending > 0 && <p class="flag">{plural(l.pending, "change")} waiting in the Inbox</p>}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

// ---------------------------------------------------------------- Activity

const OUTCOME: Record<Row["outcome"], string> = { applied: "Applied", refused: "Refused by the write gate", failed: "eBay returned an error" };

export function Activity({ onSignedOut }: ScreenProps) {
  const { data, error } = useData<Row[]>("/activity", onSignedOut);
  const rows = data ?? [];
  return (
    <>
      <h1 class="rise">Every change sent to eBay</h1>
      <p>The write gate records each attempt here, including the ones it refused.</p>
      {error && <p class="error">{error}</p>}
      {data && !rows.length && <p class="muted">Nothing has been sent yet.</p>}
      <ol class="rows">
        {rows.map((a, i) => (
          <li class="row" style={{ "--i": Math.min(i, 12) }} key={a.id}>
            <div class="row-main">
              <div class="row-ends">
                <span class="row-title">{OUTCOME[a.outcome] ?? a.outcome}</span>
                <span class="row-figure small">{ago(a.at)}</span>
              </div>
              <p class="meta">
                {[a.call, a.kind?.replace(/_/g, " "), a.item_id && `item ${a.item_id}`, a.env].filter(Boolean).join(" · ")}
              </p>
              {a.outcome !== "applied" && a.response && <p class="muted">{a.response}</p>}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

// ---------------------------------------------------------------- Settings

const keyBytes = (b64: string) => {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

function deviceName(ua: string | null) {
  if (!ua) return "A device";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "A device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${os}, ${browser}` : os;
}

export function Settings({ me, reloadMe, onSignedOut }: ScreenProps) {
  const devices = useData<Device[]>("/push/devices", onSignedOut);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);

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
      if (!me.vapidPublicKey) return "Notifications aren't set up on the server yet (VAPID_KEY).";
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return "Notifications are blocked for this site. Allow them in the browser's site settings.";
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(me.vapidPublicKey) }));
      await api("/push/subscribe", { body: { subscription: sub.toJSON() } });
      await devices.reload();
      return "This device will now get approval notifications.";
    });

  const testPush = () =>
    run(async () => {
      await api("/push/test", { body: {} });
      reloadMe();
      return "Sent. It should arrive within a few seconds.";
    });

  const setPaused = (paused: boolean) =>
    run(async () => {
      await api("/settings/writes", { body: { paused } });
      reloadMe();
    });

  const signOut = () => run(async () => (await api("/logout", { body: {} }), onSignedOut()));

  const removeDevice = (endpoint: string) =>
    run(async () => {
      await api("/push/unsubscribe", { body: { endpoint } });
      await devices.reload();
    });

  const writes =
    me.writeMode !== "approval" ? "Off: this deployment is read-only" : me.writesPaused ? "Paused" : "Applied after your approval";
  return (
    <>
      <h1 class="rise">Settings</h1>

      <section class="section">
        <h2>Account</h2>
        <dl class="figures">
          <div>
            <dt>eBay</dt>
            <dd>{me.ebayEnv === "production" ? "Your real account" : "Sandbox test account"}</dd>
          </div>
          <div>
            <dt>Signed in with</dt>
            <dd>{me.ebayConnected ? (me.ebayScopes === "read-only" ? "Read-only permissions" : "Full permissions") : "Not connected"}</dd>
          </div>
          <div>
            <dt>Changes</dt>
            <dd>{writes}</dd>
          </div>
        </dl>
        {me.writeMode === "approval" &&
          (me.writesPaused ? (
            <button class="btn btn-primary" disabled={busy} onClick={() => setPaused(false)}>
              Resume changes
            </button>
          ) : (
            <button class="btn btn-quiet" disabled={busy} onClick={() => setPaused(true)}>
              Pause all changes
            </button>
          ))}
        <p class="muted small">Pausing stops the write gate at once. Approvals you make while paused wait until you resume.</p>
      </section>

      <section class="section">
        <h2>Notifications</h2>
        <dl class="figures">
          <div>
            <dt>This device</dt>
            <dd>
              {permission === "granted" ? "Allowed" : permission === "denied" ? "Blocked" : permission === "unsupported" ? "Not supported here" : "Not turned on"}
            </dd>
          </div>
          <div>
            <dt>Last delivered</dt>
            <dd>{ago(me.lastPushAt)}</dd>
          </div>
        </dl>
        <div class="actions">
          {permission !== "unsupported" && (
            <button class="btn btn-primary" disabled={busy} onClick={enablePush}>
              Turn on for this device
            </button>
          )}
          <button class="btn btn-text" disabled={busy || !(devices.data ?? []).length} onClick={testPush}>
            Send a test
          </button>
        </div>
        {(devices.data ?? []).length > 0 && (
          <ul class="devices">
            {devices.data!.map((d) => (
              <li class="row-ends" key={d.endpoint}>
                <span>
                  {deviceName(d.user_agent)}
                  <span class="muted small"> · added {ago(d.created_at)}{d.last_error ? ` · last error: ${d.last_error}` : ""}</span>
                </span>
                <button class="btn-link" onClick={() => removeDevice(d.endpoint)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <p class="muted small">On Android, open this site in Chrome and choose Install app, then turn notifications on here.</p>
      </section>

      {note && (
        <p class="result" role="status">
          {note}
        </p>
      )}

      <section class="section">
        <button class="btn-link" onClick={signOut}>
          Sign out
        </button>
      </section>
    </>
  );
}
