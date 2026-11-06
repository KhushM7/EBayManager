import { motion } from "framer-motion";
import { useEffect, useState } from "preact/hooks";
import { api, apiJob, SignedOut } from "./api";
import { ago, money } from "./format";
import type { ScreenProps } from "./screens";
import { EASE_OUT, Icons, Ring, SPRING } from "./ui";

// The first-day audit report (src/firstday.ts), K's facts box and K's reply style guide (src/style.ts).
// Read-only on eBay. What needs doing is in the Inbox (to-dos and labels); this page is the summary and the
// figures behind it, folded away.

interface Finding {
  area: string;
  severity: "high" | "medium" | "low";
  itemId?: string | null;
  itemTitle?: string | null;
  title: string;
  detail: string;
  fix: "proposal" | "claude" | "you" | "none";
}

interface ListingAudit {
  itemId: string;
  title: string;
  url: string | null;
  price: number | null;
  postage: number | null;
  postageKind?: string;
  collectionOnly: boolean;
  listedDays: number | null;
  watchers: number;
  views7d: number | null;
  photos: number;
  specifics: number;
  descriptionChars: number;
  pricing: { strategy: string; price: number | null; why: string; confidence: number; question?: string } | null;
  promotion: { action: string; rate: number | null; why: string; suggestedRate: number | null; currentRate?: number | null } | null;
  advice?: { action: "revise" | "relist"; why: string };
  factsFromK?: string | null;
  published?: { product: string | null; exact: boolean; note: string; specs: { name: string; value: string; source: string; sourceTitle: string }[] } | null;
  findings: Finding[];
}

interface Style {
  tone: string;
  length: string;
  greeting: string;
  signOff: string;
  habits: string[];
  phrasings: { topic: string; example: string }[];
  avoid: string[];
  source: { replies: number; from: string | null; to: string | null; learned: boolean };
  at: number;
  editedBy: string | null;
}

interface Report {
  at: number;
  env: string;
  seller: { userId: string; feedbackScore: number | null; positivePercent: number | null; businessType: string | null } | null;
  listings: ListingAudit[];
  sold: {
    count: number;
    revenue: number;
    median: number | null;
    first: string | null;
    last: string | null;
    byMonth: { month: string; sales: number; revenue: number }[];
    top: { title: string; price: number; date: string }[];
    avgDaysToSell: number | null;
    timedSales: number;
  };
  unsold: { itemId: string; title: string; price: number | null; days: number | null; watchers: number; views: number | null; likely: string }[];
  messages: { replies: number; questionsAnswered: number; note: string };
  settings: {
    policies: {
      returns: { id: string; name: string; accepted: boolean; periodDays: number | null; buyerPaysReturnPostage: boolean | null }[];
      postage: { id: string; name: string; handlingDays: number | null; services: { service: string; cost: number | null; free: boolean }[]; collection: boolean }[];
      payment: { id: string; name: string }[];
    } | null;
    note: string;
  };
  findings: Finding[];
  proposals: { id: string; kind: string; itemId: string | null }[];
  forClaude: string[];
  steps: Record<string, string>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function postageText(l: ListingAudit): string | null {
  if (l.collectionOnly || l.postageKind === "collection") return "collection only";
  if (l.postageKind === "free") return "free postage";
  if (l.postageKind === "calculated") return "buyer pays postage (set by eBay per buyer)";
  return l.postage != null ? `buyer pays ${money(l.postage)} postage` : null;
}

/** The manufacturer's published specs Claude found for the exact product, each with its source. */
function Published({ p }: { p: NonNullable<ListingAudit["published"]> }) {
  if (!p.exact) return <p class="wide small muted" style={{ margin: "4px 0 0" }}>Published specs: not looked up, because {p.note.charAt(0).toLowerCase() + p.note.slice(1)}</p>;
  if (!p.specs.length) return <p class="wide small muted" style={{ margin: "4px 0 0" }}>Published specs for the {p.product}: none found.</p>;
  return (
    <details class="wide small" style={{ margin: "4px 0 0" }}>
      <summary>
        {p.specs.length} published specs for the {p.product}
      </summary>
      <ul>
        {p.specs.map((s) => (
          <li>
            {s.name}: <strong>{s.value}</strong>{" "}
            <a href={s.source} target="_blank" rel="noopener noreferrer">
              {s.sourceTitle || new URL(s.source).hostname}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** K's facts about one item (measurements, faults, what's included) and the floor price. On Listings. */
export function Facts({ itemId, hasFloor, onSignedOut }: { itemId: string; hasFloor: boolean; onSignedOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [floor, setFloor] = useState("");
  const [own, setOwn] = useState<number | null>(null);
  const [clearOwn, setClearOwn] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () =>
    api<{ floorPrice: number | null; notes: string | null; ownPrice: number | null }>(`/items/${itemId}/settings`)
      .then((s) => (setNotes(s.notes ?? ""), setFloor(s.floorPrice != null ? String(s.floorPrice) : ""), setOwn(s.ownPrice), setClearOwn(false), setOpen(true)))
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setMsg(e.message)));
  const save = () =>
    api(`/items/${itemId}/settings`, { body: { notes, floorPrice: floor.trim() === "" ? null : Number(floor), clearOwnPrice: clearOwn } })
      .then(() => (setMsg(clearOwn ? "Saved. The engine prices this listing again from the next check." : "Saved. Claude uses these facts in listing edits and replies, marked as from you."), setOpen(false)))
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setMsg(e.message)));
  return (
    <div class="wide" style={{ margin: "6px 0 0" }}>
      {!open ? (
        <button class="btn-link" onClick={load}>
          {hasFloor ? "Facts and floor price" : "Add facts and a floor price"}
        </button>
      ) : (
        <div class="form">
          <label>
            Facts only you know: measurements, weight, what works and what doesn't, marks, what's included
            <textarea rows={4} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
          </label>
          <label>
            Lowest price you'd accept (floor), £
            <input inputMode="decimal" value={floor} onInput={(e) => setFloor((e.target as HTMLInputElement).value)} />
          </label>
          {own != null && (
            <label class="choice">
              <input type="checkbox" checked={clearOwn} onChange={() => setClearOwn(!clearOwn)} />
              Your own price is £{own.toFixed(2)}, so the engine leaves it alone. Tick to let the engine price it again.
            </label>
          )}
          <div class="actions">
            <button class="btn btn-stamp" onClick={save}>
              Save
            </button>
            <button class="btn btn-text" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <p class="small result">{msg}</p>}
    </div>
  );
}

export function Report({ me, onSignedOut, onChanged, go }: ScreenProps) {
  const [report, setReport] = useState<Report | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const owner = me.user.role === "owner";

  const fail = (e: unknown) => (e instanceof SignedOut ? onSignedOut() : setError((e as Error).message));
  const load = () =>
    api<{ report: Report | null }>("/firstday")
      .then((r) => setReport(r.report))
      .catch(fail);
  useEffect(() => {
    load();
  }, []);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await apiJob<{ report: Report }>("/firstday/run", {});
      setReport(r.report);
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setRunning(false);
    }
  };

  const intro = "A read-only check of the whole shop: every listing, your sales, ended listings, past replies and settings. Nothing changes on eBay.";
  if (report === undefined)
    return error ? (
      <p class="error">{error}</p>
    ) : (
      <div class="card">
        <div class="skeleton h-5 w-40" />
        <div class="skeleton mt-4 h-24 w-full" />
      </div>
    );

  if (!report)
    return (
      <>
        <div class="page-head">
          <div>
            <h1>Store Pulse</h1>
            <p>{intro}</p>
          </div>
        </div>
        {error && <p class="error">{error}</p>}
        <div class="card flex flex-col items-start gap-3">
          {owner ? (
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={running} onClick={run}>
              <Icons.pulse size={16} /> {running ? "Reading your shop (a minute or two)" : "Check my shop"}
            </motion.button>
          ) : (
            <p>Not run yet. It runs on the first night after eBay is connected, or K can run it now.</p>
          )}
        </div>
      </>
    );

  // What needs doing lives in the Inbox: to-dos for what only K can do, labels for changes already drafted.
  const toDo = report.findings.filter((f) => f.fix === "you").length + report.listings.filter((l) => l.findings.some((f) => f.fix === "claude")).length;
  const failed = Object.entries(report.steps).filter(([, v]) => v.startsWith("failed"));
  const returns = report.settings.policies?.returns ?? [];
  const checks: [string, boolean][] = [
    ["Every part of your shop was read", failed.length === 0],
    ["Every listing has 4 or more photos", report.listings.length > 0 && report.listings.every((l) => l.photos >= 4)],
    ["Descriptions say more than the title", report.listings.length > 0 && report.listings.every((l) => l.descriptionChars >= 200)],
    ["Returns accepted, buyer pays return postage", returns.length > 0 && returns.every((r) => r.accepted && r.buyerPaysReturnPostage !== false)],
    ["Sales history on file", report.sold.count > 0],
    ["Nothing waiting for you", toDo + report.proposals.length === 0],
  ];
  const passed = checks.filter(([, ok]) => ok).length;

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Store Pulse</h1>
          <p>
            Checked {ago(report.at)}: {plural(report.listings.length, "listing")}, {plural(report.sold.count, "past sale")}, {plural(report.unsold.length, "ended listing")} and{" "}
            {plural(report.messages.replies, "past reply", "past replies")}.
          </p>
        </div>
        {owner && (
          <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" disabled={running} onClick={run}>
            <Icons.refresh size={16} /> {running ? "Checking…" : "Check again"}
          </motion.button>
        )}
      </div>
      {error && <p class="error">{error}</p>}

      <section class="card grid items-center gap-6 md:grid-cols-[auto_minmax(0,1fr)]">
        <div class="flex flex-col items-center gap-2 text-center">
          <Ring value={passed / checks.length} size={148} stroke={12} color={passed === checks.length ? "var(--green)" : passed >= checks.length / 2 ? "var(--accent)" : "var(--yellow)"}>
            <div>
              <span class="block text-3xl font-bold tabular-nums">
                {passed}/{checks.length}
              </span>
              <span class="text-xs text-muted">checks passed</span>
            </div>
          </Ring>
        </div>
        <div>
          <ul class="m-0 grid gap-2.5 p-0">
            {checks.map(([label, ok], i) => (
              <motion.li key={label} class="flex list-none items-center gap-3" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 + i * 0.14, ease: EASE_OUT }}>
                <motion.span
                  class={`grid size-6 flex-none place-items-center rounded-full ${ok ? "bg-green text-[#04130d]" : "bg-yellow-soft text-yellow"}`}
                  initial={{ scale: 0, rotate: -45 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ ...SPRING, delay: 0.3 + i * 0.14 }}
                  style={ok ? { boxShadow: "0 0 14px -2px var(--green)" } : undefined}
                >
                  {ok ? <Icons.check size={14} /> : <Icons.alert size={13} />}
                </motion.span>
                <span class={ok ? "" : "text-ink-2"}>{label}</span>
              </motion.li>
            ))}
          </ul>
          {(toDo > 0 || report.proposals.length > 0) && (
            <div class="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <span class="text-sm text-muted">
                It left {[toDo && plural(toDo, "suggestion"), report.proposals.length && `${plural(report.proposals.length, "change")} to approve`].filter(Boolean).join(" and ")}.
              </span>
              <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" onClick={() => go("/")}>
                Open the Inbox <Icons.arrowRight size={16} />
              </motion.button>
            </div>
          )}
          {failed.length > 0 && (
            <p class="flag mt-3">
              {plural(failed.length, "part")} couldn't be read: {failed.map(([k]) => k.replace(/_/g, " ")).join(", ")}.
            </p>
          )}
        </div>
      </section>

      <details class="section fold">
        <summary>
          <h2>Listings</h2>
          <span class="small muted">{plural(report.listings.length, "listing")} as eBay shows them</span>
        </summary>
        <ol class="bars">
          {report.listings.map((l) => (
            <li class="bar" key={l.itemId}>
              <span class="item-title" style={{ margin: 0 }}>
                {l.title}
              </span>
              <span class="money">{money(l.price)}</span>
              <p class="wide small" style={{ margin: 0 }}>
                {[
                  l.listedDays != null && `${l.listedDays} days listed`,
                  plural(l.watchers, "watcher"),
                  l.views7d != null && `${l.views7d} views in 7 days`,
                  plural(l.photos, "photo"),
                  plural(l.specifics, "item specific"),
                  postageText(l),
                  l.promotion?.currentRate != null ? `promoted at ${l.promotion.currentRate}%` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {l.pricing && (
                <p class="wide small muted" style={{ margin: 0 }}>
                  Market: {l.pricing.strategy === "ask" ? "the engine needs your answer (in the Inbox)" : l.pricing.strategy === "own" ? `your own price, ${money(l.pricing.price)}` : `${l.pricing.strategy} at ${money(l.pricing.price)}`}
                </p>
              )}
              {l.published && <Published p={l.published} />}
            </li>
          ))}
        </ol>
      </details>

      <details class="section fold">
        <summary>
          <h2>Sold history</h2>
          <span class="small muted">{report.sold.count ? `${plural(report.sold.count, "sale")}, ${money(report.sold.revenue)}` : "no sales recorded"}</span>
        </summary>
        {report.sold.count ? (
          <div class="paper">
            <dl class="figures">
              <div>
                <dt>Sales</dt>
                <dd>{report.sold.count}</dd>
              </div>
              <div>
                <dt>Revenue</dt>
                <dd>{money(report.sold.revenue)}</dd>
              </div>
              <div>
                <dt>Median sale</dt>
                <dd>{money(report.sold.median)}</dd>
              </div>
              <div>
                <dt>Days to sell</dt>
                <dd>{report.sold.avgDaysToSell != null && report.sold.timedSales >= 5 ? `about ${Math.round(report.sold.avgDaysToSell)}` : "too few dated sales"}</dd>
              </div>
            </dl>
            <p class="small muted">
              {report.sold.first} to {report.sold.last}.{" "}
              {report.sold.avgDaysToSell != null && report.sold.timedSales >= 5 && `Days to sell from the ${plural(report.sold.timedSales, "sale")} whose listing date is known.`}
            </p>
            <table class="chart-table">
              <caption class="small">Sales by month</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Sales</th>
                  <th scope="col">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {report.sold.byMonth.map((m) => (
                  <tr>
                    <td>{m.month}</td>
                    <td>{m.sales}</td>
                    <td>{money(m.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p class="kind" style={{ marginTop: "20px" }}>Best sales</p>
            <ul>
              {report.sold.top.map((t) => (
                <li>
                  {t.title}: <span class="money">{money(t.price)}</span> <span class="muted small">{t.date}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p class="paper">No sales recorded. Import the Seller Hub orders report in Settings.</p>
        )}
      </details>

      <details class="section fold">
        <summary>
          <h2>Ended without selling</h2>
          <span class="small muted">{report.unsold.length ? plural(report.unsold.length, "listing") : "none in the last 60 days"}</span>
        </summary>
        {report.unsold.length ? (
          <ol class="labels">
            {report.unsold.map((u) => (
              <li class="paper">
                <p class="item-title">
                  {u.title} <span class="money">{money(u.price)}</span>
                </p>
                <p class="small muted">
                  {[u.days != null && `${u.days} days listed`, plural(u.watchers, "watcher"), u.views != null && `${u.views} views`].filter(Boolean).join(" · ")}
                </p>
                <p>{u.likely}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p class="paper">None in the last 60 days (as far back as eBay shows).</p>
        )}
      </details>

      <details class="section fold">
        <summary>
          <h2>Settings</h2>
          <span class="small muted">{report.seller?.businessType ?? "seller type not stated"}</span>
        </summary>
        <div class="paper">
          {report.seller && (
            <p>
              Seller {report.seller.userId}: {report.seller.businessType ?? "type not stated"}
              {report.seller.feedbackScore != null && `, feedback ${report.seller.feedbackScore}`}
              {report.seller.positivePercent != null && ` (${report.seller.positivePercent}% positive)`}.
            </p>
          )}
          <p class="small muted">{report.settings.note}</p>
          {report.settings.policies?.returns.map((r) => (
            <p>
              Returns, "{r.name}": {r.accepted ? `accepted within ${r.periodDays ?? "?"} days, ${r.buyerPaysReturnPostage === false ? "you pay" : "buyer pays"} return postage` : "not accepted"}.
            </p>
          ))}
          {report.settings.policies?.postage.map((p) => (
            <p>
              Postage, "{p.name}": {p.handlingDays != null ? `${p.handlingDays}-day handling` : "handling not set"};{" "}
              {p.services.map((s) => `${s.service.replace(/^UK_/, "").replace(/([a-z])([A-Z])/g, "$1 $2")} ${s.free ? "free" : money(s.cost)}`).join(", ") || "no UK service"}
              {p.collection ? "; collection available" : ""}.
            </p>
          ))}
        </div>
      </details>

      <details class="section fold">
        <summary>
          <h2>What was checked</h2>
          <span class="small muted">{failed.length ? `${plural(failed.length, "part")} failed` : "every part read"}</span>
        </summary>
        <ul class="paper small">
          {Object.entries(report.steps).map(([k, v]) => (
            <li class={v.startsWith("failed") ? "flag" : undefined}>
              {k.replace(/_/g, " ")}: {v}
            </li>
          ))}
        </ul>
      </details>
      <p class="small muted">Your reply style guide is in Settings. Facts and floor prices are on each listing in Listings.</p>
    </>
  );
}

// ---------------------------------------------------------------- The reply style guide

/** K's reply style guide, on Settings. */
export function StyleCard({ owner, onSignedOut }: { owner: boolean; onSignedOut: () => void }) {
  const [style, setStyle] = useState<Style | null | undefined>(undefined);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ style: Style | null }>("/style")
      .then((r) => setStyle(r.style))
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setMsg(e.message)));
  }, []);

  const edit = () =>
    style &&
    setDraft({
      tone: style.tone,
      length: style.length,
      greeting: style.greeting,
      signOff: style.signOff,
      habits: style.habits.join("\n"),
      phrasings: style.phrasings.map((p) => `${p.topic}: ${p.example}`).join("\n"),
      avoid: style.avoid.join("\n"),
    });

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
    try {
      const r = await api<{ style: Style }>("/style", {
        body: {
          style: {
            tone: draft.tone,
            length: draft.length,
            greeting: draft.greeting,
            signOff: draft.signOff,
            habits: lines(draft.habits),
            phrasings: lines(draft.phrasings).map((l) => {
              const i = l.indexOf(":");
              return i > 0 ? { topic: l.slice(0, i).trim(), example: l.slice(i + 1).trim() } : { topic: "general", example: l };
            }),
            avoid: lines(draft.avoid),
          },
        },
      });
      setStyle(r.style);
      setDraft(null);
      setMsg("Saved. Every new draft follows it.");
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (key: string, label: string, multi = false) => (
    <label>
      {label}
      {multi ? (
        <textarea rows={4} value={draft![key]} onInput={(e) => setDraft({ ...draft!, [key]: (e.target as HTMLTextAreaElement).value })} />
      ) : (
        <input value={draft![key]} onInput={(e) => setDraft({ ...draft!, [key]: (e.target as HTMLInputElement).value })} />
      )}
    </label>
  );

  return (
    <section class="paper">
      <h2>Your reply style</h2>
      <div>
        <p class="small muted">
          Every reply and offer message Claude drafts follows this guide. The rules still come first: only facts from the listing, no price
          agreements, everything kept on eBay.
        </p>
        {style === undefined && <p aria-busy="true" />}
        {style === null && <p>No guide yet. It's learned when Store Pulse runs.</p>}
        {style && !draft && (
          <>
            <dl class="figures">
              <div>
                <dt>Tone</dt>
                <dd>{style.tone}</dd>
              </div>
              <div>
                <dt>Length</dt>
                <dd>{style.length}</dd>
              </div>
              <div>
                <dt>Greeting</dt>
                <dd>{style.greeting || "none"}</dd>
              </div>
              <div>
                <dt>Sign-off</dt>
                <dd>{style.signOff || "none"}</dd>
              </div>
            </dl>
            {style.habits.length > 0 && (
              <ul>
                {style.habits.map((h) => (
                  <li>{h}</li>
                ))}
              </ul>
            )}
            {style.phrasings.map((p) => (
              <p class="quote">
                <span class="kind">{p.topic}</span> {p.example}
              </p>
            ))}
            {style.avoid.length > 0 && <p class="small">Avoids: {style.avoid.join("; ")}.</p>}
            <p class="small muted">
              {style.source.learned
                ? `Learned from ${plural(style.source.replies, "reply", "replies")}${style.source.from ? ` (${style.source.from} to ${style.source.to})` : ""}.`
                : "A plain starting guide: there were no past replies to learn from."}
              {style.editedBy && ` Edited by ${style.editedBy} ${ago(style.at)}.`}
            </p>
            {owner && (
              <button class="btn btn-ink" onClick={edit}>
                Edit to sound like you
              </button>
            )}
          </>
        )}
        {draft && (
          <div class="form">
            {field("tone", "Tone")}
            {field("length", "Length")}
            {field("greeting", "Greeting (blank for none)")}
            {field("signOff", "Sign-off (blank for none)")}
            {field("habits", "Habits, one per line", true)}
            {field("phrasings", 'How you word common answers, one per line as "topic: example"', true)}
            {field("avoid", "Things you never do, one per line", true)}
            <div class="actions">
              <button class="btn btn-stamp" disabled={busy} onClick={save}>
                Save
              </button>
              <button class="btn btn-text" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {msg && <p class="result">{msg}</p>}
      </div>
    </section>
  );
}
