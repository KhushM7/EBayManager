import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { ago, money, plural } from "./format";
import { Icons, Toasts, useToasts } from "./ui";

// Offers and sales (src/offersapi.ts): every offer eBay has shown the app, live and past, and sales. Each answer
// becomes a label and is approved by the same tap; only the write gate sends it. Messages have their own screen.

interface OfferRow {
  best_offer_id: string;
  item_id: string;
  item_title?: string | null;
  buyer: string;
  price: number;
  list_price?: number | null;
  buyer_message?: string | null;
  full_price?: boolean;
  first_seen?: number;
  seen_at?: number;
  expires_at?: number | null;
  outcome?: string | null;
  answered_by?: "app" | "ebay" | null;
  proposal_id: string | null;
  open: boolean;
  waiting_on: "you" | "buyer" | null;
  floor: number | null;
  label_status: string | null;
  label_result: string | null;
}

interface SaleRow {
  id: string;
  at: number;
  title: string;
  price: number | null;
  itemIds: string[];
  state: "paid" | "dispatched" | "unpaid" | "cancelled" | "imported";
}

interface Props {
  me: Me;
  onSignedOut: () => void;
  onChanged: () => void;
  go: (to: string) => void;
}

const SALE_WORDS: Record<SaleRow["state"], [string, string]> = {
  paid: ["Sold: to post", "state-decide"],
  unpaid: ["Bought, not paid", "state-decide"],
  dispatched: ["Sold", "state-applied"],
  imported: ["Sold", "state-applied"],
  cancelled: ["Cancelled", "state-off"],
};

/** "in 3 hours", for an offer that lapses. */
const left = (ms: number) => {
  const h = (ms - Date.now()) / 3_600_000;
  return h <= 0 ? "expired" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min left` : `${Math.round(h)} h left`;
};

async function approve(id: string): Promise<string> {
  const { results } = await api<{ results: { id: string; result: string }[] }>("/proposals/decide", { body: { ids: [id], decision: "approve" } });
  return results[0]?.result ?? "Nothing was decided";
}

function OpenOffer({ o, done, fail }: { o: OfferRow; done: (msg: string) => void; fail: (e: unknown) => void }) {
  const [action, setAction] = useState<"accept" | "counter" | "decline" | null>(null);
  const [counter, setCounter] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const price = action === "counter" ? Number(counter) : o.price;
  const below = o.floor != null && (action === "accept" || (action === "counter" && price > 0)) && price < o.floor;

  const send = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { action, counterPrice: Number(counter) || null, message };
      let id = o.proposal_id;
      if (o.label_status === "pending" && id) await api(`/proposals/${id}/edit`, { body });
      else id = (await api<{ id: string }>("/offers/answer", { body: { ...body, bestOfferId: o.best_offer_id } })).id;
      done(await approve(id!));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article class="card">
      <p class="font-semibold">{o.item_title || `Listing ${o.item_id}`}</p>
      <p class="meta mt-1">
        {o.full_price ? <strong>Full asking price, {money(o.price)}</strong> : <strong>{money(o.price)} offered</strong>}
        {o.list_price != null && !o.full_price ? `, asking ${money(o.list_price)}` : ""} by {o.buyer || "a buyer"}
        {o.expires_at ? ` · ${left(o.expires_at)}` : ""}
      </p>
      {o.buyer_message && <blockquote class="quote">{o.buyer_message}</blockquote>}
      {o.waiting_on === "buyer" ? (
        <p class="muted small mt-2">Your counter-offer is waiting for the buyer.</p>
      ) : (
        <form class="form mt-3" onSubmit={send}>
          <div class="actions">
            {(["accept", "counter", "decline"] as const).map((a) => (
              <button type="button" key={a} class={`btn ${action === a ? "btn-primary" : "btn-secondary"}`} aria-pressed={action === a} onClick={() => setAction(action === a ? null : a)}>
                {a === "accept" ? `Accept ${money(o.price)}` : a === "counter" ? "Counter" : "Decline"}
              </button>
            ))}
          </div>
          {action && (
            <>
              {action === "counter" && (
                <>
                  <label for={`c-${o.best_offer_id}`}>Your price (£)</label>
                  <input id={`c-${o.best_offer_id}`} type="number" inputMode="decimal" min="0.01" step="0.01" value={counter} onInput={(e) => setCounter(e.currentTarget.value)} required />
                </>
              )}
              <label for={`m-${o.best_offer_id}`}>Message to the buyer (optional)</label>
              <input id={`m-${o.best_offer_id}`} type="text" maxLength={250} value={message} onInput={(e) => setMessage(e.currentTarget.value)} />
              {below && <p class="error">This is below your floor of {money(o.floor)}.</p>}
              <div class="actions">
                <button class="btn btn-primary" disabled={busy}>
                  {busy ? "Sending" : action === "accept" ? "Confirm: accept and sell" : action === "counter" ? "Confirm: send counter" : "Confirm: decline"}
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </article>
  );
}

export function Offers({ onSignedOut, onChanged }: Props) {
  const [data, setData] = useState<{ offers: OfferRow[]; canMessage: boolean; lastPoll: { at: number; errors: string[] } | null } | null>(null);
  const [sales, setSales] = useState<SaleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const toasts = useToasts();
  const fail = (e: unknown) => {
    if (e instanceof SignedOut) onSignedOut();
    else toasts.push("bad", (e as Error).message);
  };
  const load = () =>
    Promise.all([api("/offers").then(setData), api("/sales").then(setSales)])
      .then(() => setError(null))
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setError((e as Error).message)));
  useEffect(() => {
    load();
  }, []);

  const refresh = async () => {
    setChecking(true);
    try {
      const r = await api<{ offers: number; questions: number; errors: string[]; busy?: boolean }>("/inbox/poll", { body: {} });
      toasts.push(r.errors.length ? "bad" : "info", r.busy ? "Already checking eBay." : r.errors.length ? "eBay couldn't be fully read. The details are in the log." : r.offers + r.questions ? `${plural(r.offers, "new offer")}, ${plural(r.questions, "new question")}.` : "Nothing new on eBay.");
      await load();
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setChecking(false);
    }
  };

  const open = (data?.offers ?? []).filter((o) => o.open);
  const past = (data?.offers ?? []).filter((o) => !o.open);
  return (
    <div class="max-w-3xl">
      <div class="page-head">
        <div>
          <h1>Offers and sales</h1>
          <p>{data?.lastPoll ? `eBay checked ${ago(data.lastPoll.at)}${data.lastPoll.errors.length ? ", with problems" : ""}.` : "eBay is checked every 5 minutes."}</p>
        </div>
        <button class="btn btn-secondary" onClick={refresh} disabled={checking}>
          <Icons.refresh size={16} /> {checking ? "Checking eBay" : "Refresh"}
        </button>
      </div>
      {error && <p class="error">{error}</p>}

      <h2 class="inbox-sub">Offers to answer</h2>
      {data && !open.length && <p class="muted">No offers are waiting.</p>}
      <div class="grid gap-3">
        {open.map((o) => (
          <OpenOffer key={o.best_offer_id} o={o} done={(m) => (toasts.push(/ok\b|^Approved/.test(m) ? "good" : "bad", m), load(), onChanged())} fail={fail} />
        ))}
      </div>

      <h2 class="inbox-sub section mt-6">Sales</h2>
      {sales && !sales.length && <p class="muted">No sales in the last 90 days.</p>}
      <div class="grid gap-3">
        {(sales ?? []).slice(0, 30).map((s) => (
          <article class="card flex items-center justify-between gap-3" key={s.id}>
            <div>
              <p class="font-semibold">{s.title}</p>
              <p class="text-sm text-muted">{ago(s.at)}</p>
            </div>
            <div class="text-right">
              <p class="font-semibold">{money(s.price)}</p>
              <span class={`state ${SALE_WORDS[s.state][1]}`}>{SALE_WORDS[s.state][0]}</span>
            </div>
          </article>
        ))}
      </div>

      {past.length > 0 && (
        <details class="section">
          <summary class="inbox-sub cursor-pointer">Past offers ({past.length})</summary>
          <div class="grid gap-3">
            {past.map((o) => (
              <article class="card" key={o.best_offer_id}>
                <p class="font-semibold">{o.item_title || `Listing ${o.item_id}`}</p>
                <p class="text-sm text-muted">
                  {money(o.price)}
                  {o.full_price ? " (full asking price)" : o.list_price != null ? ` against ${money(o.list_price)}` : ""} · {o.outcome ?? "expired"}
                  {o.answered_by === "app" ? " from the app" : o.answered_by === "ebay" ? " on eBay" : ""} · {ago(o.first_seen ?? o.seen_at)}
                </p>
              </article>
            ))}
          </div>
        </details>
      )}
      <Toasts items={toasts.items} />
    </div>
  );
}

/** On the Listings page: what sold lately, since a sold listing leaves the list. */
export function SoldStrip({ go }: { go: (to: string) => void }) {
  const [rows, setRows] = useState<SaleRow[]>([]);
  useEffect(() => {
    api<SaleRow[]>("/sales")
      .then((r) => setRows(r.filter((s) => s.state !== "cancelled" && s.at > Date.now() - 14 * 86_400_000)))
      .catch(() => {});
  }, []);
  if (!rows.length) return null;
  return (
    <div class="card mb-5">
      <p class="text-sm font-semibold text-muted">Sold in the last 14 days</p>
      {rows.map((s) => (
        <p class="mt-2 flex items-center justify-between gap-3" key={s.id}>
          <span>{s.title}</span>
          <span class="flex items-center gap-2">
            {money(s.price)} <span class={`state ${SALE_WORDS[s.state][1]}`}>{s.state === "unpaid" ? "Not paid" : "Sold"}</span>
          </span>
        </p>
      ))}
      <button class="btn-link mt-2" onClick={() => go("/offers")}>
        All sales and offers
      </button>
    </div>
  );
}
