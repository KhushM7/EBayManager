import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { Chart, type Point } from "./chart";
import { ago, money } from "./format";

interface MetricsData {
  listings: { day: string; active: number; asking: number; watchers: number }[];
  sales: { day: string; orders: number; revenue: number; fees: number }[];
  spend: { day: string; usd: number; calls: number }[];
  sold30: { items: number; revenue: number; fees: number; sellThrough: number | null } | null;
  avgDaysToSell: number | null;
  proposals: Record<string, number>;
  medianMinutesToDecide: number | null;
  flags: { item_id: string; flag: string; detail: string; title: string | null }[];
  lastNightly: { at: number; steps: Record<string, string>; triaged: number; proposals: number } | null;
}

const FLAG_NAMES: Record<string, string> = {
  stale: "No watchers",
  watched_not_selling: "Watched, not selling",
  low_views: "Few views",
  low_click_through: "Seen but not opened",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const count = (n: number) => String(Math.round(n));
const usd = (n: number) => "$" + n.toFixed(2);
const pct = (n: number | null | undefined) => (n == null ? "Not enough data" : `${Math.round(n * 100)}%`);
const duration = (mins: number | null) =>
  mins == null
    ? "No decisions yet"
    : mins < 60
      ? `${Math.round(mins)} minutes`
      : mins < 2880
        ? `${Math.round(mins / 60)} hours`
        : `${Math.round(mins / 1440)} days`;

/** Fills missing days with zero so daily bars line up with the calendar. */
function daily<T extends { day: string }>(rows: T[], days: number, value: (r: T) => number): Point[] {
  const byDay = new Map(rows.map((r) => [r.day, value(r)]));
  const out: Point[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, value: byDay.get(day) ?? 0 });
  }
  return out;
}

export function Metrics({ onSignedOut }: { me: Me; reloadMe: () => void; onSignedOut: () => void }) {
  const [data, setData] = useState<MetricsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = () =>
    api<MetricsData>("/metrics")
      .then(setData)
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setError(e.message)));
  useEffect(() => {
    load();
  }, []);

  const runNow = async () => {
    setRunning(true);
    try {
      await api("/nightly", { body: {} });
      await load();
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  if (error) return <p class="error">{error}</p>;
  if (!data) return <h1 class="title-in">Metrics</h1>;

  const s = data.sold30;
  const approved = (data.proposals.applied ?? 0) + (data.proposals.approved ?? 0);
  const rejected = data.proposals.rejected ?? 0;
  const failedSteps = data.lastNightly ? Object.entries(data.lastNightly.steps).filter(([, v]) => v.startsWith("failed")) : [];

  return (
    <>
      <div class="page-head">
        <h1 class="title-in">Metrics</h1>
        <p>The last 30 days, read from eBay every night.</p>
      </div>
      <div class="paper">
      <p class="kind">Revenue, last 30 days</p>
      <p class="receipt-total">{money(s?.revenue ?? 0)}</p>
      <p>{s?.items ? `${plural(s.items, "item")} sold.` : "No sales yet."}</p>
      <div class="receipt-tear">
      <dl class="figures">
        <div>
          <dt>eBay fees, last 30 days</dt>
          <dd>{money(s?.fees ?? 0)}</dd>
        </div>
        <div>
          <dt>Sell-through</dt>
          <dd>{pct(s?.sellThrough)}</dd>
        </div>
        <div>
          <dt>Average days to sell</dt>
          <dd>{data.avgDaysToSell == null ? "Not enough data" : `${Math.round(data.avgDaysToSell)} days`}</dd>
        </div>
        <div>
          <dt>Changes in 30 days</dt>
          <dd>
            {approved} approved, {rejected} rejected
          </dd>
        </div>
        <div>
          <dt>Typical time to decide</dt>
          <dd>{duration(data.medianMinutesToDecide)}</dd>
        </div>
      </dl>
      </div>
      </div>

      <section class="section paper stack">
        <h2>Listings</h2>
        <Chart title="Active listings" kind="line" points={data.listings.map((r) => ({ day: r.day, value: r.active }))} format={count} />
        <Chart title="Total asking value" kind="line" points={data.listings.map((r) => ({ day: r.day, value: r.asking }))} format={money} />
        <Chart title="Watchers" kind="line" points={data.listings.map((r) => ({ day: r.day, value: r.watchers }))} format={count} />
      </section>

      <section class="section paper">
        <h2>Sales</h2>
        <Chart title="Revenue per day" kind="bar" points={daily(data.sales, 30, (r) => r.revenue)} format={money} />
      </section>

      <section class="section paper">
        <h2>Nightly check</h2>
        {data.lastNightly ? (
          <p>
            Last ran {ago(data.lastNightly.at)}: {data.lastNightly.steps.health ?? "health not checked"}, {data.lastNightly.triaged} reviewed by Claude,{" "}
            {plural(data.lastNightly.proposals, "proposal")} made.
          </p>
        ) : (
          <p>It runs every night at 02:00 UTC and hasn't run yet.</p>
        )}
        {data.flags.length > 0 && (
          <ul class="flags">
            {data.flags.map((f) => (
              <li key={f.item_id + f.flag}>
                <span class="row-title">{FLAG_NAMES[f.flag] ?? f.flag}</span>
                <p class="meta">{f.title ?? `Item ${f.item_id}`}</p>
                <p class="muted">{f.detail}</p>
              </li>
            ))}
          </ul>
        )}
        {failedSteps.length > 0 && (
          <p class="muted small">
            Steps that didn't finish: {failedSteps.map(([k]) => k).join(", ")}. eBay's Sandbox doesn't provide traffic data, so that step fails there.
          </p>
        )}
        <button class="btn btn-quiet" disabled={running} onClick={runNow}>
          {running ? "Checking" : "Run the check now"}
        </button>
      </section>

      <section class="section paper">
        <h2>Claude</h2>
        <Chart
          title="Claude spend per day"
          kind="bar"
          points={daily(data.spend, 30, (r) => r.usd)}
          format={usd}
          reference={{ value: 1, label: "Daily budget $1.00" }}
        />
      </section>
    </>
  );
}
