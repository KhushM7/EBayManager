import { useEffect, useState } from "preact/hooks";
import { api, SignedOut } from "./api";
import { ago, money } from "./format";
import { readSalesReport } from "../../src/salesreport";

// Settings card for the sold-price providers: usage against each monthly cap, and K's comparison test.

interface Estimate {
  count: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
  errorPct: number | null;
  inBand: boolean | null;
}

interface Engine extends Estimate {
  recommended: number | null;
  strategy: string;
  regime: string;
  query: string;
  matchedBy: string;
  close?: number;
  seen?: string;
  note?: string;
}

interface Status {
  providers: { provider: "trawl" | "compsapi"; enabled: boolean; used: number; cap: number }[];
  primary: string | null;
  lastEval: {
    at: number;
    items: { itemId: string; title: string; actual: number; actualTotal?: number | null; results: Record<string, Estimate | Engine | { error: string }> }[];
    summary: Record<string, { priced: number; meanErrorPct: number | null; inBand: number }>;
    primary: string | null;
  } | null;
}

const NAMES: Record<string, string> = { trawl: "Trawl", compsapi: "CompsAPI", engine: "Pricing engine" };

function engineCell(r: Engine | { error: string } | undefined, actualTotal: number | null | undefined) {
  if (!r) return <span class="muted">Not run</span>;
  if ("error" in r) return <span class="muted">{r.error}</span>;
  if (r.median == null)
    return (
      <span class="muted">
        {r.strategy === "ask" ? `Would ask you: ${r.query}` : "No matches"}
        {r.note ? `. ${r.note}` : ""}
      </span>
    );
  return (
    <>
      {money(r.median)}{" "}
      <span class="muted small">
        ({r.count} exact{r.close ? ` + ${r.close} close` : ""} matches, {r.errorPct}% off{actualTotal != null ? ", with postage" : ""})
      </span>
      <br />
      <span class="small">
        {r.regime}; would {r.strategy}
        {r.recommended != null ? ` at ${money(r.recommended)}` : ""}. Search: "{r.query}"{r.seen ? `. Read: ${r.seen}` : ""}
      </span>
      {r.note && (
        <>
          <br />
          <span class="small muted">{r.note}</span>
        </>
      )}
    </>
  );
}

function cell(r: Estimate | { error: string } | undefined) {
  if (!r) return <span class="muted">Not set up</span>;
  if ("error" in r) return <span class="muted">{r.error}</span>;
  if (r.median == null) return <span class="muted">No matching sales</span>;
  return (
    <>
      {money(r.median)} <span class="muted small">({r.count} sales, {r.errorPct}% off)</span>
    </>
  );
}

export function SoldDataCard({ owner, onSignedOut }: { owner: boolean; onSignedOut: () => void }) {
  const [data, setData] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<Status>("/solddata")
      .then(setData)
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setError(e.message)));
  useEffect(() => {
    load();
  }, []);

  const runTest = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/solddata/evaluate", { body: {} });
      await load();
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const [imported, setImported] = useState<string | null>(null);
  const importReport = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setImported(null);
    try {
      // Read on this device: only the seven sales columns leave it, never buyers' details.
      const { sales, skipped } = readSalesReport(await file.text());
      if (!sales.length) throw new Error("No sales found in that file.");
      const out = await api<{ imported: number; alreadyThere: number }>("/sales/import", { body: { sales } });
      const dates = sales.map((s) => s.date).sort();
      setImported(
        `${out.imported} past sales imported (${dates[0]} to ${dates.at(-1)})${out.alreadyThere ? `, ${out.alreadyThere} were already there` : ""}${skipped ? `, ${skipped} rows skipped` : ""}. Buyer details were left out on this device.`,
      );
    } catch (err) {
      if (err instanceof SignedOut) onSignedOut();
      else setError((err as Error).message);
    } finally {
      setBusy(false);
      (e.currentTarget as HTMLInputElement).value = "";
    }
  };

  const ev = data?.lastEval;
  const hasEngine = Boolean(ev?.items.some((i) => i.results.engine));
  return (
    <section class="paper span">
      <h2>Sold-price data</h2>
      <p>Real sold listings from two outside providers, used for prices and offers. Only search words are sent; each has a hard monthly limit.</p>
      {data && (
        <dl class="figures">
          {data.providers.map((p) => (
            <div key={p.provider}>
              <dt>
                {NAMES[p.provider]}
                {data.primary === p.provider ? " (used first)" : ""}
              </dt>
              <dd>{p.enabled ? `${p.used} of ${p.cap} used this month` : "Not set up"}</dd>
            </div>
          ))}
        </dl>
      )}
      {ev && (
        <div class="evidence" style={{ overflowX: "auto" }}>
          <p>
            <strong>Comparison test, {ago(ev.at)}:</strong> each provider priced items you've already sold, then the pricing engine priced them as the market stood on the day you sold. Closer to what you got is better.
          </p>
          <table class="chart-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">You got</th>
                <th scope="col">Trawl</th>
                <th scope="col">CompsAPI</th>
                {hasEngine && <th scope="col">Pricing engine (both pooled, Claude-checked)</th>}
              </tr>
            </thead>
            <tbody>
              {ev.items.map((i) => (
                <tr key={i.itemId}>
                  <td>{i.title}</td>
                  <td>
                    {money(i.actual)}
                    {i.actualTotal != null && <span class="muted small"> ({money(i.actualTotal)} with postage)</span>}
                  </td>
                  <td>{cell(i.results.trawl as Estimate)}</td>
                  <td>{cell(i.results.compsapi as Estimate)}</td>
                  {hasEngine && <td>{engineCell(i.results.engine as Engine, i.actualTotal)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: "10px" }}>
            {Object.entries(ev.summary)
              .map(([p, s]) => `${NAMES[p]}: ${s.meanErrorPct == null ? "no prices" : `${s.meanErrorPct}% off on average`}, ${s.priced} of ${ev.items.length} priced`)
              .join(" · ")}
            {ev.primary ? `. ${NAMES[ev.primary]} is used first.` : ""}
          </p>
        </div>
      )}
      {error && <p class="error">{error}</p>}
      {owner && (
        <div class="form">
          <label for="sales-report">Import past sales (Seller Hub orders report, CSV)</label>
          <input id="sales-report" type="file" accept=".csv,text/csv" disabled={busy} onChange={importReport} />
          <p class="small muted" style={{ margin: 0 }}>
            eBay only shares the last 90 days of orders, so older sales come from this report. It's read on this device and only item number,
            title, quantity, price, postage and date are sent. Buyers' names, addresses and emails never leave this device.
          </p>
          {imported && <p class="result">{imported}</p>}
        </div>
      )}
      {owner && (
        <div class="actions">
          <button class="btn btn-ink" disabled={busy || !data?.providers.some((p) => p.enabled)} onClick={runTest}>
            {busy ? "Testing (about a minute)" : ev ? "Run the comparison test again" : "Run the comparison test"}
          </button>
        </div>
      )}
      <p class="small muted" style={{ marginTop: "12px" }}>
        The test uses up to 5 searches from each provider's monthly allowance, up to 5 more each for the engine's own searches (more for
        bundles), and a few cents of Claude.
      </p>
    </section>
  );
}
