import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { ago, money } from "./format";
import { Icons } from "./ui";

// The Bundle assistant (src/bundles.ts): which related listings to put in eBay's bundle discounts, at what
// percentages, and how to set it on eBay. eBay has no way for an app to do it, so nothing here changes eBay.

interface Part { itemId: string; title: string; price: number }
interface Tier { count: number; percent: number }
interface Example { count: number; percent: number; low: Sum; high: Sum | null }
interface Sum { titles: string[]; full: number; pays: number; saves: number; youGet: number }
interface Group { id: string; name: string; source: "claude" | "rules" | "k"; reason: string; itemIds: string[]; items: Part[]; leftOut: { itemId: string; title: string; why: string }[]; tiers: Tier[]; examples: Example[]; valid: boolean }
interface View {
  listings: (Part & { unfit: string | null })[];
  active: { groupId: string; name: string; since: number; days: number; by: string; tiers: Tier[]; orders: number; items: Part[]; sold: number; examples: Example[]; minDays: number } | null;
  suggestion: { key: string; action: string; groupId: string; title: string; why: string; itemIds: string[]; exclude: string[]; tiers: Tier[]; guide: { where: string; steps: string[] }[]; examples: Example[] } | null;
  groups: Group[];
  history: { name: string; itemIds: string[]; tiers: Tier[]; from: number; to: number; orders: number }[];
  splits: { itemId: string; title: string; price: number; total: number; parts: { name: string; price: number }[] }[];
}

const tierText = (t: Tier[]) => (t.length ? t.map((x) => `Buy ${x.count === 4 ? "4 or more" : x.count}: ${x.percent}% off`).join(" · ") : "No safe discount");

function Examples({ rows }: { rows: Example[] }) {
  if (!rows.length) return null;
  const line = (s: Sum) => `${money(s.full)} becomes ${money(s.pays)}, saving ${money(s.saves)}; you get about ${money(s.youGet)}`;
  return (
    <ul class="mt-2 grid gap-1 text-sm text-muted">
      {rows.map((e) => (
        <li key={e.count}>
          <span class="font-semibold text-ink">Any {e.count === 4 ? "4 or more" : e.count}</span>: {e.high ? `cheapest ${line(e.low)}. Dearest ${line(e.high)}.` : `${line(e.low)}.`}
        </li>
      ))}
    </ul>
  );
}

/** One line in the Inbox: what's running, and the way to the Bundles page on a phone. */
export function BundleStrip({ go, onSignedOut }: { go: (to: string) => void; onSignedOut: () => void }) {
  const [v, setV] = useState<View | null>(null);
  useEffect(() => {
    api<View>("/bundles").then(setV).catch((e) => e instanceof SignedOut && onSignedOut());
  }, []);
  if (!v) return null;
  return (
    <button class="card mb-4 flex w-full items-center gap-3 text-left" onClick={() => go("/bundles")}>
      <Icons.box size={20} />
      <span class="min-w-0 flex-1">
        <span class="block font-semibold">Bundles</span>
        <span class="block text-sm text-muted">{v.active ? `"${v.active.name}" active for ${v.active.days} ${v.active.days === 1 ? "day" : "days"}` : (v.suggestion?.title ?? "No group running")}</span>
      </span>
      <Icons.arrowRight size={18} />
    </button>
  );
}

function Editor({ v, start, busy, onSave, onCancel }: { v: View; start: Group | null; busy: boolean; onSave: (b: { id?: string; name: string; itemIds: string[] }) => void; onCancel: () => void }) {
  const [name, setName] = useState(start?.name ?? "");
  const [ids, setIds] = useState(new Set(start?.itemIds ?? []));
  const toggle = (id: string) => setIds((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  return (
    <div class="card grid gap-3">
      <label class="grid gap-1 text-sm">
        Group name
        <input value={name} maxLength={60} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <div class="grid gap-2">
        {v.listings.map((l) => (
          <label key={l.itemId} class="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={ids.has(l.itemId)} onChange={() => toggle(l.itemId)} />
            <span>
              {l.title} <span class="text-muted">{money(l.price)}{l.unfit ? `, won't be discounted: ${l.unfit}` : ""}</span>
            </span>
          </label>
        ))}
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-primary" disabled={busy || !name.trim() || ids.size < 2} onClick={() => onSave({ id: start?.id, name, itemIds: [...ids] })}>Save group</button>
        <button class="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function Bundles({ me, onSignedOut, onChanged }: { me: Me; onSignedOut: () => void; onChanged: () => void }) {
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [where, setWhere] = useState(0);
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const owner = me.user.role === "owner";
  const call = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      setV(await api<View>(path, body === undefined ? {} : { body }));
      setEditing(null);
      if (body !== undefined) setTicked(new Set());
      onChanged();
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => void call("/bundles"), []);
  if (!v) return <div class="max-w-3xl"><div class="page-head"><div><h1>Bundles</h1><p>{error ?? "Checking…"}</p></div></div></div>;

  const x = v.suggestion;
  const tick = (id: string) => setTicked((s) => (s.has(id) ? new Set([...s].filter((y) => y !== id)) : new Set([...s, id])));
  return (
    <div class="grid max-w-3xl gap-5">
      <div class="page-head">
        <div>
          <h1>Bundles</h1>
          <p>One group of related listings at a time gets a discount for buying several. The listings stay separate.</p>
        </div>
      </div>
      {error && <p class="error" role="alert">{error}</p>}

      <section class="card" aria-label="Active group">
        <p class="kind">Active now</p>
        {v.active ? (
          <>
            <h2 class="text-lg font-semibold">{v.active.name}</h2>
            <p class="text-sm text-muted">
              {v.active.days} {v.active.days === 1 ? "day" : "days"} active, set by {v.active.by}. {v.active.orders} {v.active.orders === 1 ? "order" : "orders"} of several items so far{v.active.sold ? `, ${v.active.sold} listings sold or ended` : ""}.
              {v.active.days < v.active.minDays ? ` A swap is considered after ${v.active.minDays} days.` : ""}
            </p>
            <p class="mt-2 font-semibold">{tierText(v.active.tiers)}</p>
            <ul class="mt-2 grid gap-1 text-sm">{v.active.items.map((i) => <li key={i.itemId}>{i.title} <span class="text-muted">{money(i.price)}</span></li>)}</ul>
            <Examples rows={v.active.examples} />
          </>
        ) : (
          <p class="text-sm text-muted">No group is marked as running. If bundle discounts are already on in eBay, follow the steps below so the two agree.</p>
        )}
      </section>

      {x ? (
        <section class="card grid gap-3" aria-label="Next step">
          <div>
            <p class="kind">Next step</p>
            <h2 class="text-lg font-semibold">{x.title}</h2>
            <p class="text-sm">{x.why}</p>
          </div>
          {x.tiers.length > 0 && <div><p class="font-semibold">{tierText(x.tiers)}</p><Examples rows={x.examples} /></div>}
          <div>
            <div class="tabs" role="tablist">
              {x.guide.map((g, i) => <button key={g.where} role="tab" aria-selected={i === where} class="tab" onClick={() => setWhere(i)}><span>{g.where}</span></button>)}
            </div>
            <ol class="mt-3 grid list-decimal gap-2 pl-5 text-sm">{(x.guide[where] ?? x.guide[0]).steps.map((s) => <li key={s}>{s}</li>)}</ol>
          </div>
          {x.action !== "off" && (
            <div class="grid gap-2">
              <p class="font-semibold">Exclude and include on eBay</p>
              {v.listings.map((l) => {
                const out = x.exclude.includes(l.itemId);
                return (
                  <label key={l.itemId} class="flex items-start gap-3 text-sm">
                    <input type="checkbox" checked={ticked.has(l.itemId)} onChange={() => tick(l.itemId)} aria-label={`${l.title} checked on eBay`} />
                    <span class={`state ${out ? "state-off" : "state-applied"}`}>{out ? "Exclude" : "Include"}</span>
                    <span>{l.title}</span>
                  </label>
                );
              })}
              <p class="text-sm text-muted">The ticks are only to keep your place.</p>
            </div>
          )}
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-primary" disabled={busy} onClick={() => call("/bundles/confirm", { key: x.key })}>I've done this</button>
            <button class="btn btn-secondary" disabled={busy} onClick={() => call("/bundles/snooze", { key: x.key })}>Not now</button>
          </div>
        </section>
      ) : (
        <p class="text-sm text-muted">Nothing to change on eBay. The assistant looks again every night.</p>
      )}

      <section class="grid gap-3" aria-label="Groups">
        <div class="flex items-center justify-between gap-3">
          <h2 class="inbox-sub">Groups</h2>
          {owner && editing !== "new" && <button class="btn btn-secondary" onClick={() => setEditing("new")}><Icons.plus size={16} /> New group</button>}
        </div>
        {editing === "new" && <Editor v={v} start={null} busy={busy} onSave={(b) => call("/bundles/groups", b)} onCancel={() => setEditing(null)} />}
        {!v.groups.length && <p class="text-sm text-muted">No related listings found yet.</p>}
        {v.groups.map((g) =>
          editing !== "new" && editing?.id === g.id ? (
            <Editor key={g.id} v={v} start={g} busy={busy} onSave={(b) => call("/bundles/groups", b)} onCancel={() => setEditing(null)} />
          ) : (
            <div key={g.id} class="card">
              <p class="kind">{g.source === "k" ? "Your group" : g.source === "claude" ? "Found by Claude" : "Found by rules"}{g.id === v.active?.groupId ? " · active" : ""}</p>
              <h3 class="font-semibold">{g.name}</h3>
              <p class="text-sm text-muted">{g.reason}</p>
              <ul class="mt-2 grid gap-1 text-sm">
                {g.items.map((i) => <li key={i.itemId}>{i.title} <span class="text-muted">{money(i.price)}</span></li>)}
                {g.leftOut.map((i) => <li key={i.itemId} class="text-muted">{i.title}: left out, {i.why}</li>)}
              </ul>
              <p class="mt-2 text-sm font-semibold">{g.valid ? tierText(g.tiers) : "Can't run at the moment: it needs two listings with room for a discount."}</p>
              {owner && (
                <div class="mt-3 flex flex-wrap gap-4">
                  {g.valid && g.id !== v.active?.groupId && <button class="btn-link" disabled={busy} onClick={() => call(`/bundles/groups/${g.id}/choose`, {})}>Use this group next</button>}
                  <button class="btn-link" disabled={busy} onClick={() => setEditing(g)}>Edit</button>
                  <button class="btn-link" disabled={busy} onClick={() => call(`/bundles/groups/${g.id}/dismiss`, {})}>Dismiss</button>
                </div>
              )}
            </div>
          ),
        )}
      </section>

      {v.splits.length > 0 && (
        <section class="card" aria-label="Worth splitting">
          <p class="kind">Worth splitting</p>
          {v.splits.map((s) => <p key={s.itemId} class="text-sm">{s.title}, listed at {money(s.price)}: its parts come to about {money(s.total)} on their own ({s.parts.map((p) => `${p.name} ${money(p.price)}`).join(", ")}).</p>)}
        </section>
      )}

      {v.history.length > 0 && (
        <section class="card" aria-label="Past groups">
          <p class="kind">Past groups</p>
          <ul class="grid gap-2 text-sm">
            {v.history.map((h) => <li key={h.from}><span class="font-semibold">{h.name}</span>: {Math.max(0, Math.floor((h.to - h.from) / 86_400_000))} days, {h.orders} {h.orders === 1 ? "order" : "orders"} of several items, {tierText(h.tiers)}. Ended {ago(h.to)}.</li>)}
          </ul>
        </section>
      )}
      <p class="text-sm text-muted">Percentages come off your listed price. What you get is your price less the discount; what buyers pay includes eBay's buyer fee.</p>
    </div>
  );
}
