import type { Env } from "../env";
import { log } from "../log";
import { redact } from "../redact";
import { esc, trading, TradingError } from "./trading";

// Buyer questions, Best Offers and sold items, read with Trading read verbs only. Replies and offer responses
// are proposals applied by the write gate (src/ebay/write.ts).
//
// No offer had ever been recorded when this was rewritten (2026-11-24) and nothing said what eBay had answered, so
// every call now returns a diagnosis: acknowledgement, warnings, counts, why anything was dropped, and the shape
// of the reply (element names and counts). Never a buyer's name, a message or any other text from a buyer.

export interface Question {
  messageId: string;
  itemId: string;
  itemTitle: string;
  sender: string;
  body: string;
  receivedAt: number;
}

export interface Offer {
  bestOfferId: string;
  itemId: string;
  itemTitle: string;
  listPrice: number | null;
  price: number;
  buyer: string;
  buyerMessage: string;
  expiresAt: number | null;
  /** eBay's status word (Active, Pending, Accepted...), or "" when the reply has none. */
  status?: string;
  /** BuyerBestOffer, BuyerCounterOffer or SellerCounterOffer. */
  codeType?: string;
  /** Seller, or Buyer for an offer K made on someone else's listing. */
  role?: string;
  quantity?: number;
}

/** One eBay call, for the poll record and the log. */
export interface CallDiag {
  call: string;
  itemId?: string;
  ack: string;
  errors: { code: string; severity: string; text: string }[];
  pages: number;
  returned: number;
  kept: number;
  dropped: Record<string, number>;
  statuses: Record<string, number>;
  roles: Record<string, number>;
  codeTypes: Record<string, number>;
  /** Figures that show whether eBay's offer price is the buyer's or the seller's: prices only. */
  prices: string[];
  structure: string;
  ms: number;
  failed?: string;
}

const num = (v: any) => (v == null ? null : Number(v?.["#text"] ?? v));
const text = (v: any) => (v == null ? "" : String(v?.["#text"] ?? v));
const tally = (t: Record<string, number>, k: string) => void (t[k] = (t[k] ?? 0) + 1);
/** eBay's own enumeration words only: anything else is not shown. */
const word = (v: unknown) => (/^[A-Za-z]{1,40}$/.test(String(v ?? "")) ? String(v) : v == null || v === "" ? "none" : "other");

/** The reply's shape: element paths with how many of each, no values at all. */
export function structure(doc: unknown, max = 70): string {
  const seen = new Map<string, number>();
  const walk = (v: any, path: string, depth: number) => {
    if (depth > 7) return;
    for (const x of Array.isArray(v) ? v : [v]) {
      if (path) seen.set(path, (seen.get(path) ?? 0) + 1);
      if (x && typeof x === "object") for (const [k, c] of Object.entries(x)) if (!k.startsWith("@_") && k !== "#text") walk(c, path ? `${path}/${k}` : k, depth + 1);
    }
  };
  walk(doc, "", 0);
  const all = [...seen].map(([p, n]) => (n > 1 ? `${p}x${n}` : p));
  return all.slice(0, max).join(" ") + (all.length > max ? ` (+${all.length - max})` : "");
}

export function newDiag(call: string, itemId?: string): CallDiag {
  return { call, ...(itemId ? { itemId } : {}), ack: "none", errors: [], pages: 0, returned: 0, kept: 0, dropped: {}, statuses: {}, roles: {}, codeTypes: {}, prices: [], structure: "", ms: 0 };
}

const errorsOf = (doc: any) =>
  [doc?.Errors ?? []].flat().map((e: any) => ({ code: text(e?.ErrorCode), severity: word(e?.SeverityCode), text: redact(text(e?.ShortMessage), 160) }));

function note(d: CallDiag, doc: any) {
  d.pages++;
  d.ack = word(doc?.Ack);
  d.errors.push(...errorsOf(doc));
  if (d.pages === 1) d.structure = structure(doc);
}

/** Logs a call: in full when it returned something, warned or failed; one line only when it was quietly empty. */
export async function logCall(env: Env, d: CallDiag): Promise<void> {
  const loud = Boolean(d.failed) || d.errors.length > 0 || d.returned > 0 || d.ack !== "Success";
  const { structure: shape, ...rest } = d;
  await log(env, d.failed ? "error" : d.errors.length || d.ack !== "Success" ? "warn" : "info", "inbox.call", { job: "poll", itemId: d.itemId, ms: d.ms, detail: JSON.stringify(rest), lineOnly: !loud });
  if (loud) await log(env, "info", "inbox.call.shape", { job: "poll", itemId: d.itemId, detail: `${d.call}: ${shape}` });
}

/** Runs a read and fills in how it went; a failure is thrown after being noted. */
async function timed<T>(d: CallDiag, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    return await fn();
  } catch (e) {
    d.failed = redact(e instanceof Error ? e.message : String(e), 300);
    if (e instanceof TradingError) {
      d.ack = "Failure";
      d.errors.push(...errorsOf(e.doc));
      d.structure = structure(e.doc);
    }
    throw e;
  } finally {
    d.ms = Date.now() - t;
  }
}

export function toQuestions(doc: any): Question[] {
  const exchanges = [doc.MemberMessage?.MemberMessageExchange ?? []].flat();
  return exchanges
    .filter((x: any) => x.Question?.MessageID)
    .map((x: any) => ({
      messageId: String(x.Question.MessageID),
      itemId: String(x.Item?.ItemID ?? ""),
      itemTitle: String(x.Item?.Title ?? ""),
      sender: String(x.Question.SenderID ?? ""),
      body: String(x.Question.Body ?? ""),
      receivedAt: Date.parse(x.CreationDate ?? x.Question.CreationDate ?? "") || Date.now(),
    }));
}

/**
 * Best Offers from either shape eBay uses: ItemBestOffersArray (the whole account), or BestOfferArray with its
 * Item at the top (one listing). Reading only the first would lose every offer of a one-listing call.
 */
export function toOffers(doc: any, itemId = ""): Offer[] {
  const groups = [doc.ItemBestOffersArray?.ItemBestOffers ?? []].flat();
  if (doc.BestOfferArray) groups.push({ Item: doc.Item, BestOfferArray: doc.BestOfferArray, Role: doc.Role });
  return groups.flatMap((ib: any) =>
    [ib?.BestOfferArray?.BestOffer ?? []].flat().map((o: any) => ({
      bestOfferId: text(o.BestOfferID),
      itemId: text(ib.Item?.ItemID) || itemId,
      itemTitle: text(ib.Item?.Title),
      listPrice: num(ib.Item?.BuyItNowPrice ?? ib.Item?.SellingStatus?.CurrentPrice ?? ib.Item?.StartPrice),
      price: Number(num(o.Price) ?? 0),
      buyer: text(o.Buyer?.UserID),
      buyerMessage: text(o.BuyerMessage),
      expiresAt: Date.parse(text(o.ExpirationTime)) || null,
      status: text(o.Status ?? o.BestOfferStatus),
      codeType: text(o.BestOfferCodeType),
      role: text(o.Role ?? ib.Role),
      quantity: num(o.Quantity) ?? 1,
    })),
  );
}

/** Statuses that mean an offer is over. Any other word, or none, counts as open, so a new word can't hide one. */
const OVER: Record<string, string> = {
  Accepted: "accepted",
  PendingBuyerPayment: "accepted",
  PendingBuyerConfirmation: "accepted",
  Acknowledged: "accepted",
  Declined: "declined",
  Expired: "expired",
  Countered: "countered",
  Retracted: "withdrawn",
  AdminEnded: "ended by eBay",
};

/** What became of an offer, or null while it's open. */
export const outcomeOf = (o: Offer, now = Date.now()): string | null => OVER[o.status ?? ""] ?? (o.expiresAt != null && o.expiresAt < now ? "expired" : null);

/** Open, and the next move is K's (K's own counter waits on the buyer). */
export const needsAnswer = (o: Offer, now = Date.now()) => o.codeType !== "SellerCounterOffer" && outcomeOf(o, now) === null;

const MAX_PAGES = 5;

/** Unanswered "ask the seller a question" messages from the last 30 days. */
export async function getUnansweredQuestions(env: Env, d = newDiag("GetMemberMessages")): Promise<Question[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  return timed(d, async () => {
    const out: Question[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const doc = await trading(
        env,
        "GetMemberMessages",
        `<MailMessageType>AskSellerQuestion</MailMessageType><MessageStatus>Unanswered</MessageStatus>
     <StartCreationTime>${start.toISOString()}</StartCreationTime><EndCreationTime>${end.toISOString()}</EndCreationTime>
     <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`,
      );
      note(d, doc);
      const raw = [doc.MemberMessage?.MemberMessageExchange ?? []].flat();
      const qs = toQuestions(doc);
      d.returned += raw.length;
      d.kept += qs.length;
      if (raw.length > qs.length) d.dropped["no message id"] = (d.dropped["no message id"] ?? 0) + raw.length - qs.length;
      for (const x of raw) tally(d.statuses, word((x as any)?.MessageStatus));
      out.push(...qs);
      if (page >= Number(doc.PaginationResult?.TotalNumberOfPages ?? 1)) break;
    }
    return out;
  });
}

async function offersCall(env: Env, d: CallDiag, inner: (page: number) => string, itemId = ""): Promise<Offer[]> {
  return timed(d, async () => {
    const out: Offer[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const doc = await trading(env, "GetBestOffers", inner(page));
      note(d, doc);
      for (const o of toOffers(doc, itemId)) {
        d.returned++;
        tally(d.statuses, word(o.status));
        tally(d.roles, word(o.role));
        tally(d.codeTypes, word(o.codeType));
        const why = !o.bestOfferId ? "no offer id" : o.role === "Buyer" ? "K's own offer as a buyer" : !/^\d{9,14}$/.test(o.itemId) ? "no item id" : !(o.price > 0) ? "no price" : null;
        if (why) {
          tally(d.dropped, why);
          continue;
        }
        d.kept++;
        if (d.prices.length < 10) d.prices.push(`offer ${o.price} listed ${o.listPrice ?? "none"}`);
        out.push(o);
      }
      if (page >= Number(doc.PaginationResult?.TotalNumberOfPages ?? 1)) break;
    }
    return out;
  });
}

const offerPage = (page: number) => `<DetailLevel>ReturnAll</DetailLevel><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`;

/** Best Offers eBay calls active, across all listings (its All status works only for one listing at a time). */
export const getActiveOffers = (env: Env, d = newDiag("GetBestOffers")): Promise<Offer[]> =>
  offersCall(env, d, (p) => `<BestOfferStatus>Active</BestOfferStatus>${offerPage(p)}`);

/** eBay's failures that only mean "nothing here": 20138, the listing doesn't take Best Offers; 20140, it has had none. */
const NO_OFFERS = new Set(["20138", "20140"]);

/** Every Best Offer one listing has had, open or over. */
export async function getItemOffers(env: Env, itemId: string, d = newDiag("GetBestOffers", itemId)): Promise<Offer[]> {
  try {
    return await itemOffersCall(env, itemId, d);
  } catch (e) {
    if (!(e instanceof TradingError) || !d.errors.length || !d.errors.every((x) => NO_OFFERS.has(x.code))) throw e;
    // Not a failure: recorded as an empty answer, with eBay's code kept as the status.
    for (const x of d.errors) tally(d.statuses, `code ${x.code}`);
    d.errors = [];
    d.ack = "Success";
    delete d.failed;
    return [];
  }
}

const itemOffersCall = (env: Env, itemId: string, d: CallDiag): Promise<Offer[]> =>
  offersCall(env, d, (p) => `<ItemID>${esc(itemId)}</ItemID><BestOfferStatus>All</BestOfferStatus>${offerPage(p)}`, itemId);

/** A sale line from My eBay's sold list, which holds purchases nobody has paid for yet. No buyer fields are read. */
export interface SoldLine {
  lineId: string;
  itemId: string;
  title: string;
  quantity: number;
  price: number | null;
  createdAt: number | null;
  paid: boolean;
}

export function toSoldLines(doc: any): SoldLine[] {
  const rows = [doc.SoldList?.OrderTransactionArray?.OrderTransaction ?? []].flat();
  return rows
    .flatMap((r: any) => [r?.Transaction ?? [], r?.Order?.TransactionArray?.Transaction ?? []].flat())
    .map((t: any) => {
      const itemId = text(t?.Item?.ItemID);
      return {
        lineId: text(t?.OrderLineItemID) || (text(t?.TransactionID) ? `${itemId}-${text(t.TransactionID)}` : ""),
        itemId,
        title: text(t?.Item?.Title),
        quantity: num(t?.QuantityPurchased) ?? 1,
        price: num(t?.TransactionPrice ?? t?.TotalPrice ?? t?.Item?.SellingStatus?.CurrentPrice),
        createdAt: Date.parse(text(t?.CreatedDate)) || null,
        paid: Boolean(t?.PaidTime) || /^(Paid|MarkedAsPaid)/i.test(text(t?.SellerPaidStatus)),
      };
    });
}

export async function getSoldLines(env: Env, d = newDiag("GetMyeBaySelling:SoldList")): Promise<SoldLine[]> {
  return timed(d, async () => {
    const out: SoldLine[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const doc = await trading(
        env,
        "GetMyeBaySelling",
        `<SoldList><Include>true</Include><DurationInDays>14</DurationInDays><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></SoldList><DetailLevel>ReturnAll</DetailLevel>`,
      );
      note(d, doc);
      for (const l of toSoldLines(doc)) {
        d.returned++;
        tally(d.statuses, l.paid ? "paid" : "unpaid");
        if (!/^[\w-]{3,60}$/.test(l.lineId) || !/^\d{9,14}$/.test(l.itemId)) {
          tally(d.dropped, "no line or item id");
          continue;
        }
        d.kept++;
        out.push(l);
      }
      if (page >= Number(doc.SoldList?.PaginationResult?.TotalNumberOfPages ?? 1)) break;
    }
    return out;
  });
}
