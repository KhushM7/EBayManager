import { motion } from "framer-motion";
import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { Chart, type Point } from "./chart";
import { ago, money } from "./format";
import { CardLabel, CountUp, EASE_OUT, Icons, item, list, Ring, Sparkline, SPRING } from "./ui";

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


/** A metric with its 30-day sparkline: the figure counts up, the line draws itself. */
export function SparklineWidget({ label, icon, series, format, good = "up" }: { label: string; icon: any; series: number[]; format: (n: number) => string; good?: "up" | "down" }) {
  const last = series.length ? series[series.length - 1] : 0;
  const first = series.length ? series[0] : 0;
  const change = last - first;
  const better = good === "up" ? change > 0 : change < 0;
  return (
    <motion.div variants={item} class="card glow-hover flex flex-col justify-between gap-4">
      <CardLabel icon={icon}>{label}</CardLabel>
      <div class="flex items-end justify-between gap-3">
        <div>
          <CountUp value={last} format={format} class="text-3xl font-bold tracking-tight" />
          <p class={`mt-1 text-xs font-semibold ${change === 0 || series.length < 2 ? "text-muted" : better ? "text-green" : "text-red"}`}>
            {series.length < 2 ? "Not enough history yet" : change === 0 ? "No change in 30 days" : `${change > 0 ? "+" : "−"}${format(Math.abs(change))} in 30 days`}
          </p>
        </div>
        <Sparkline values={series} width={120} height={44} color={change === 0 ? "var(--chart)" : better ? "var(--green)" : "var(--red)"} />
      </div>
    </motion.div>
  );
}

/** Store health: each check of the last nightly run ticks in one after another. */
function HealthChecks({ steps }: { steps: Record<string, string> }) {
  const names: Record<string, string> = { snapshot: "Listings read from eBay", orders: "Orders synced", traffic: "Views and traffic", health: "Health rules checked", triage: "Claude reviewed flagged listings", pricing: "Prices reviewed", inbox: "Messages checked" };
  return (
    <ul class="m-0 grid gap-2 p-0">
      {Object.entries(steps).map(([k, v], i) => {
        const ok = !v.startsWith("failed");
        return (
          <motion.li key={k} class="flex list-none items-center gap-3 text-sm" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + i * 0.16, ease: EASE_OUT }}>
            <motion.span
              class={`grid size-6 flex-none place-items-center rounded-full ${ok ? "bg-green text-[#04130d]" : "bg-yellow-soft text-yellow"}`}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ ...SPRING, delay: 0.35 + i * 0.16 }}
              style={ok ? { boxShadow: "0 0 14px -2px var(--green)" } : undefined}
            >
              {ok ? <Icons.check size={14} /> : <Icons.alert size={13} />}
            </motion.span>
            <span class="min-w-0 flex-1">
              <span class="font-semibold">{names[k] ?? k}</span>
              {!ok && <span class="block truncate text-xs text-muted">{v}</span>}
            </span>
          </motion.li>
        );
      })}
    </ul>
  );
}

export function Metrics({ onSignedOut, go }: { me: Me; reloadMe: () => void; onSignedOut: () => void; go: (p: string) => void }) {
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

  const head = (
    <div class="page-head">
      <div>
        <h1>Insights</h1>
        <p>Your shop over the last 30 days, read from eBay every night.</p>
      </div>
      <motion.button whileTap={{ scale: 0.95 }} class="btn btn-secondary" onClick={() => go("/pulse")}>
        <Icons.pulse size={16} /> Store Pulse
      </motion.button>
    </div>
  );
  if (error) return (<>{head}<p class="error">{error}</p></>);
  if (!data)
    return (
      <>
        {head}
        <div class="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} class={`card ${i === 0 ? "md:col-span-2" : ""}`}>
              <div class="skeleton h-4 w-24" />
              <div class="skeleton mt-4 h-9 w-32" />
            </div>
          ))}
        </div>
      </>
    );

  const s = data.sold30;
  const approved = (data.proposals.applied ?? 0) + (data.proposals.approved ?? 0) + (data.proposals.agreed ?? 0);
  const rejected = data.proposals.rejected ?? 0;
  const revenueDaily = daily(data.sales, 30, (r) => r.revenue);
  const series = (f: (r: MetricsData["listings"][number]) => number) => data.listings.map(f);

  return (
    <>
      {head}
      <motion.div class="grid gap-4 md:grid-cols-4" variants={list} initial="hidden" animate="show">
        {/* Revenue: the screen's answer, biggest */}
        <motion.div variants={item} class="card glow-hover md:col-span-2">
          <CardLabel icon={<Icons.chart size={16} />} right={<span class="text-xs text-muted">Last 30 days</span>}>
            Revenue
          </CardLabel>
          <CountUp value={s?.revenue ?? 0} format={money} class="text-4xl font-bold tracking-tight sm:text-5xl" />
          <p class="mt-2 text-sm text-muted">
            {s?.items ? `${plural(s.items, "item")} sold · ${money(s.fees ?? 0)} in eBay fees` : "No sales in the last 30 days yet."}
          </p>
          <div class="mt-4">
            <Sparkline values={revenueDaily.map((p) => p.value)} width={520} height={56} class="w-full" color="var(--accent)" />
          </div>
        </motion.div>

        <motion.div variants={item} class="card glow-hover flex flex-col items-center justify-center text-center">
          <CardLabel>Sell-through</CardLabel>
          <Ring value={s?.sellThrough ?? 0} size={132} stroke={11}>
            <div>
              <span class="block text-2xl font-bold tabular-nums">{s?.sellThrough == null ? "–" : `${Math.round(s.sellThrough * 100)}%`}</span>
              <span class="text-xs text-muted">{s?.sellThrough == null ? "Not enough data" : "of listings sold"}</span>
            </div>
          </Ring>
        </motion.div>

        <motion.div variants={item} class="card glow-hover flex flex-col justify-between">
          <CardLabel icon={<Icons.clock size={16} />}>Days to sell</CardLabel>
          <div>
            {data.avgDaysToSell == null ? <span class="text-3xl font-bold text-muted">–</span> : <CountUp value={data.avgDaysToSell} class="text-4xl font-bold tracking-tight" />}
            <p class="mt-1 text-sm text-muted">{data.avgDaysToSell == null ? "Shown after a few sales" : "on average, listing to sale"}</p>
          </div>
        </motion.div>

        <SparklineWidget label="Live listings" icon={<Icons.grid size={16} />} series={series((r) => r.active)} format={count} />
        <SparklineWidget label="Watchers" icon={<Icons.heart size={16} />} series={series((r) => r.watchers)} format={count} />
        <div class="md:col-span-2">
          <SparklineWidget label="Asking value" icon={<Icons.tag size={16} />} series={series((r) => r.asking)} format={money} />
        </div>

        <motion.section variants={item} class="card md:col-span-2">
          <CardLabel icon={<Icons.chart size={16} />}>Revenue per day</CardLabel>
          <Chart title="" kind="bar" points={revenueDaily} format={money} />
        </motion.section>

        <motion.section variants={item} class="card md:col-span-2">
          <CardLabel
            icon={<Icons.pulse size={16} />}
            right={
              <motion.button whileTap={{ scale: 0.95 }} class="btn btn-text h-8 px-3 text-xs" disabled={running} onClick={runNow}>
                <Icons.refresh size={14} /> {running ? "Checking…" : "Run now"}
              </motion.button>
            }
          >
            Store health
          </CardLabel>
          {data.lastNightly ? (
            <>
              <p class="mb-4 text-sm text-muted">
                Checked {ago(data.lastNightly.at)} · {data.lastNightly.triaged} reviewed by Claude · {plural(data.lastNightly.proposals, "suggestion")}
              </p>
              <HealthChecks steps={data.lastNightly.steps} />
            </>
          ) : (
            <p class="text-sm text-muted">The first check runs tonight at 02:00.</p>
          )}
          {data.flags.length > 0 && (
            <ul class="m-0 mt-4 grid gap-2 border-t border-line p-0 pt-4">
              {data.flags.map((f) => (
                <li key={f.item_id + f.flag} class="flex list-none items-start gap-3 text-sm">
                  <span class="mt-0.5 rounded-full bg-yellow-soft px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-yellow">{FLAG_NAMES[f.flag] ?? f.flag}</span>
                  <span class="min-w-0">
                    <span class="block truncate font-semibold">{f.title ?? `Item ${f.item_id}`}</span>
                    <span class="text-muted">{f.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </motion.section>

        <motion.div variants={item} class="card md:col-span-4">
          <div class="grid gap-4 sm:grid-cols-3">
            <div>
              <p class="text-sm font-semibold text-muted">Changes approved</p>
              <CountUp value={approved} class="text-2xl font-bold" />
            </div>
            <div>
              <p class="text-sm font-semibold text-muted">Changes rejected</p>
              <CountUp value={rejected} class="text-2xl font-bold" />
            </div>
            <div>
              <p class="text-sm font-semibold text-muted">Typical time to decide</p>
              <span class="text-2xl font-bold">{duration(data.medianMinutesToDecide)}</span>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </>
  );
}
