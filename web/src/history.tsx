import { useEffect, useRef, useState } from "preact/hooks";
import { api, SignedOut } from "./api";
import { ago } from "./format";

// History: everything the app has suggested and what became of it, newest first (src/history.ts). Also records
// which suggestions were actually on screen. Nothing here changes eBay.

type Group = "done" | "declined" | "closed" | "problem";

interface Row {
  key: string;
  source: "proposal" | "todo" | "advice";
  id: string;
  kind: string;
  item_id: string | null;
  item_title: string | null;
  title: string;
  detail: string | null;
  outcome: { group: Group; words: string };
  at: number;
  filed_at: number;
}

const FILTERS: { id: Group | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "done", label: "Done" },
  { id: "declined", label: "Declined" },
  { id: "closed", label: "Closed on its own" },
  { id: "problem", label: "Problems" },
];
const SOURCES = [
  { id: "", label: "Every kind" },
  { id: "proposal", label: "Changes" },
  { id: "todo", label: "To-dos" },
  { id: "advice", label: "Bundle advice" },
];
const TONE: Record<Group, string> = { done: "state-applied", declined: "state-off", closed: "state-off", problem: "state-decide" };
const SOURCE_WORD = { proposal: "Change", todo: "To-do", advice: "Advice" };

/** Old links (?status=applied and the rest) open the right tab and filter. */
export function inboxStart(search: string): { tab: "decide" | "history"; filter: Group | "all" } {
  const p = new URLSearchParams(search);
  const old: Record<string, Group> = { applied: "done", agreed: "done", rejected: "declined", expired: "closed", failed: "problem" };
  const filter = old[p.get("status") ?? ""];
  return filter ? { tab: "history", filter } : { tab: p.get("tab") === "history" ? "history" : "decide", filter: "all" };
}

const waiting = new Set<string>();
const sent = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const flush = () => {
  timer = null;
  const ids = [...waiting];
  waiting.clear();
  if (ids.length) api("/suggestions/seen", { body: { ids } }).catch(() => ids.forEach((id) => sent.delete(id)));
};

/** A ref for a card: once half of it has been on screen, it counts as seen. */
export function useSeen(id: string) {
  const ref = useRef<any>(null);
  useEffect(() => {
    const el = ref.current as Element | null;
    if (!el || sent.has(id) || typeof IntersectionObserver === "undefined") return;
    const o = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        o.disconnect();
        sent.add(id);
        waiting.add(id);
        timer ??= setTimeout(flush, 1500);
      },
      { threshold: 0.5 },
    );
    o.observe(el);
    return () => o.disconnect();
  }, [id]);
  return ref;
}

export function History({ start, onSignedOut }: { start: Group | "all"; onSignedOut: () => void }) {
  const [filter, setFilter] = useState<Group | "all">(start);
  const [source, setSource] = useState("");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);

  const load = async (before: string | null) => {
    const mine = ++run.current;
    setBusy(true);
    setError(null);
    const p = new URLSearchParams();
    if (filter !== "all") p.set("outcome", filter);
    if (source) p.set("source", source);
    if (q) p.set("q", q);
    if (before) p.set("before", before);
    try {
      const r = await api<{ rows: Row[]; next: string | null }>(`/suggestions/history?${p}`);
      // A slower answer to an earlier filter must not replace this one.
      if (mine !== run.current) return;
      setRows((old) => (before ? [...(old ?? []), ...r.rows] : r.rows));
      setNext(r.next);
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else if (mine === run.current) setError((e as Error).message);
    } finally {
      if (mine === run.current) setBusy(false);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);
  useEffect(() => {
    setRows(null);
    load(null);
  }, [filter, source, q]);

  return (
    <section aria-label="History">
      <div class="mb-3 flex flex-wrap gap-2" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button class={`btn ${f.id === filter ? "btn-primary" : "btn-secondary"}`} aria-pressed={f.id === filter} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div class="mb-4 grid gap-2 sm:grid-cols-[1fr_auto]">
        <input type="search" placeholder="Search by listing" aria-label="Search by listing" value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} />
        <select aria-label="Kind" value={source} onChange={(e) => setSource((e.target as HTMLSelectElement).value)}>
          {SOURCES.map((s) => (
            <option value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>
      {error && <p class="error">{error}</p>}
      {!rows && !error && <div class="card"><div class="skeleton h-4 w-40" /></div>}
      {rows && !rows.length && <p class="card text-muted">Nothing here yet.</p>}
      <ol class="m-0 grid gap-3 p-0">
        {rows?.map((r) => (
          <li key={r.key} class="card list-none">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span class="font-semibold text-ink">{SOURCE_WORD[r.source]}</span>
              <span class={`state ${TONE[r.outcome.group]}`}>{r.outcome.words}</span>
              <span class="text-muted">· {ago(r.at)}</span>
            </div>
            <p class="mt-2 text-[15px] font-semibold">{r.title}</p>
            {r.item_title && <p class="mt-0.5 text-sm text-muted">{r.item_title}</p>}
            {r.detail && (
              <details class="mt-2 text-sm">
                <summary class="cursor-pointer text-muted">Why it was suggested</summary>
                <p class="mt-1 whitespace-pre-line">{r.detail}</p>
              </details>
            )}
            <p class="mt-2 text-xs text-muted">
              Suggested {ago(r.filed_at)}
              {r.item_id ? ` · item ${r.item_id}` : ""}
            </p>
          </li>
        ))}
      </ol>
      {next && (
        <button class="btn btn-secondary mt-4" disabled={busy} onClick={() => load(next)}>
          {busy ? "Loading" : "Show more"}
        </button>
      )}
    </section>
  );
}
