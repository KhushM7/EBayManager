import { useEffect, useState } from "preact/hooks";
import { api, SignedOut } from "./api";
import { ago, money } from "./format";

// The pricing engine in the dashboard (docs/pricing-engine.md): a price check on a listing, and bundle advice.

interface Option {
  total: number;
  price: number;
  daysToSell: number;
  chance30: number;
  keeps: number;
}

interface Decision {
  strategy: "compete" | "hold" | "clear" | "ask";
  price: number | null;
  total: number | null;
  options: Option[];
  why: string;
  confidence: number;
  question?: string;
}

interface Component {
  name: string;
  query: string;
  market: { mNow: number | null; mLong: number | null; trend30: number | null; weeksOfSupply: number | null; supply: number; regime: string };
  matched: { sold: number; active: number; closeSold?: number; closeActive?: number; by: string };
  found: { sold: number; active: number };
  evidence: {
    sold: { title: string; total: number; date: string | null; url: string | null; grade?: string; factor?: number }[];
    active: { title: string; total: number; url: string; grade?: string; factor?: number }[];
  };
  errors: string[];
}

export interface PriceResult {
  at: number;
  identity: { product: string; group: string; by: string };
  components: Component[];
  decision: Decision;
  method: string;
}

const STRATEGY: Record<Decision["strategy"], [string, string]> = {
  compete: ["state-applied", "Compete"],
  hold: ["state-held", "Hold"],
  clear: ["state-decide", "Clear"],
  ask: ["state-info", "Ask"],
};

const days = (d: number) => (!Number.isFinite(d) || d > 365 ? "over a year" : d <= 1 ? "about a day" : `about ${d} days`);

export function PriceReport({ r }: { r: PriceResult }) {
  const d = r.decision;
  const [cls, word] = STRATEGY[d.strategy];
  return (
    <div class="evidence wide">
      <p>
        <span class={`state ${cls}`}>{word}</span>{" "}
        {d.price != null ? (
          <>
            <strong class="money">{money(d.price)}</strong>
            {d.total != null && d.total !== d.price && <span class="muted"> (buyer pays {money(d.total)} with postage)</span>}
          </>
        ) : (
          <strong>{d.question}</strong>
        )}
      </p>
      <p>{d.why}</p>
      {d.options.length === 3 && (
        <table class="chart-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th scope="col">Price</th>
              <th scope="col">Sells in</th>
              <th scope="col">Chance in 30 days</th>
              <th scope="col">You keep</th>
            </tr>
          </thead>
          <tbody>
            {d.options.map((o, i) => (
              <tr key={i}>
                <td>
                  {money(o.price)}
                  {i === 1 ? " (recommended)" : i === 0 ? " (quicker)" : " (higher)"}
                </td>
                <td>{days(o.daysToSell)}</td>
                <td>{Math.round(o.chance30 * 100)}%</td>
                <td>{money(o.keeps)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.components.map((c) => (
        <details key={c.query} style={{ marginTop: "8px" }}>
          <summary>
            {r.components.length > 1 ? `${c.name}: ` : ""}
            {c.matched.sold} exact and {c.matched.closeSold ?? 0} close matches of {c.found.sold} sales found; {c.matched.active} exact and{" "}
            {c.matched.closeActive ?? 0} close of {c.found.active} live listings
            {c.matched.by === "claude" ? " (checked by Claude)" : " (word rules)"}. Search: "{c.query}"
          </summary>
          <p class="small">
            Clearing {c.market.mNow != null ? money(c.market.mNow) : "?"}, usual {c.market.mLong != null ? money(c.market.mLong) : "?"}
            {c.market.trend30 != null ? `, ${c.market.trend30 >= 0 ? "+" : ""}${Math.round(c.market.trend30 * 100)}% a month` : ""}
            {c.market.weeksOfSupply != null ? `, ${c.market.weeksOfSupply} weeks of supply` : ""}. Totals include postage.
          </p>
          <ul class="small">
            {c.evidence.sold.map((s, i) => (
              <li key={`s${i}`}>
                Sold {s.date ?? ""} {money(s.total)}
                {s.grade === "close" ? ` (close match, counted as ${money(s.total * (s.factor ?? 1))})` : ""}:{" "}
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.title}
                  </a>
                ) : (
                  s.title
                )}
              </li>
            ))}
            {c.evidence.active.map((a, i) => (
              <li key={`a${i}`}>
                Listed {money(a.total)}
                {a.grade === "close" ? ` (close match, counted as ${money(a.total * (a.factor ?? 1))})` : ""}:{" "}
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {a.title}
                </a>
              </li>
            ))}
          </ul>
          {c.errors.map((e) => (
            <p class="small muted">{e}</p>
          ))}
        </details>
      ))}
      <p class="small muted">
        Confidence {Math.round(d.confidence * 100)}%. {r.method === "sum of parts" ? "Priced as the sum of its parts. " : ""}Checked {ago(r.at)}. Nothing
        changes on eBay unless you approve a price label.
      </p>
    </div>
  );
}

export function PriceCheck({ itemId, onSignedOut }: { itemId: string; onSignedOut: () => void }) {
  const [state, setState] = useState<{ busy?: boolean; result?: PriceResult; error?: string }>({});
  const check = async () => {
    setState({ busy: true });
    try {
      setState({ result: await api<PriceResult>("/pricing/check", { body: { itemId } }) });
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setState({ error: (e as Error).message });
    }
  };
  return (
    <>
      <button class="btn-link" disabled={state.busy} onClick={check}>
        {state.busy ? "Checking the market (up to a minute)" : state.result ? "Check again" : "Check the price"}
      </button>
      {state.error && <p class="wide error">{state.error}</p>}
      {state.result && <PriceReport r={state.result} />}
    </>
  );
}

interface Advice {
  id: string;
  at: number;
  kind: "combine" | "split";
  itemIds: string[];
  title: string;
  reason: string;
  separately: number;
  together: number;
  daysSeparately: number;
  daysTogether: number;
}

export function BundleAdvice({ onSignedOut }: { onSignedOut: () => void }) {
  const [rows, setRows] = useState<Advice[]>([]);
  useEffect(() => {
    api<Advice[]>("/pricing/advice")
      .then(setRows)
      .catch((e) => e instanceof SignedOut && onSignedOut());
  }, []);
  const dismiss = async (id: string) => {
    setRows((r) => r.filter((a) => a.id !== id));
    await api("/pricing/advice/dismiss", { body: { id } }).catch(() => {});
  };
  if (!rows.length) return null;
  return (
    <section class="paper" style={{ marginBottom: "16px" }} aria-label="Bundle advice">
      <p class="kind">Advice</p>
      {rows.map((a) => (
        <div key={a.id} style={{ marginBottom: "12px" }}>
          <h3 style={{ margin: "0 0 4px" }}>
            {a.kind === "combine" ? "Sell together" : "Sell separately"}: {a.title}
          </h3>
          <p style={{ margin: "0 0 4px" }}>{a.reason}</p>
          <p class="small">
            {a.kind === "combine" ? "Together" : "As listed"}: about {money(a.kind === "combine" ? a.together : a.together)} in {days(a.daysTogether)}.{" "}
            {a.kind === "combine" ? "Separately" : "Split"}: about {money(a.separately)}
            {a.kind === "combine" ? `, the last selling in ${days(a.daysSeparately)}` : ""}. Values allow for waiting.
            <span class="muted"> Items {a.itemIds.join(", ")}.</span>
          </p>
          <button class="btn-link" onClick={() => dismiss(a.id)}>
            Dismiss
          </button>
        </div>
      ))}
      <p class="small muted" style={{ margin: 0 }}>Advice only. Any listing change you decide on still comes to you as a label.</p>
    </section>
  );
}
