import { XMLParser } from "fast-xml-parser";
import type { Env } from "../env";
import { userToken } from "./auth";
import { assertRest, assertTrading, REST_WRITE, TRADING_READ } from "./allowlist";
import { ebayHosts, isEbayPictureHost, PRODUCTION_HOSTS } from "./hosts";

const COMPAT_LEVEL = "1349";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Trading verbs that only read (src/ebay/allowlist.ts). Anything else goes through src/ebay/write.ts. */
export const READ_VERBS = TRADING_READ;

/** Calls a read-only Trading API verb and returns the parsed `<Verb>Response` element. */
export async function trading(env: Env, call: string, innerXml: string): Promise<any> {
  if (!READ_VERBS.has(call)) throw new Error(`${call} is not a read call; eBay writes go through the write gate`);
  assertTrading(call, "read");
  return tradingRequest(env, call, innerXml);
}

/** Sends any Trading verb. Only this file and src/ebay/write.ts may call it (enforced by test). */
export async function tradingRequest(env: Env, call: string, innerXml: string): Promise<any> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_GB</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${innerXml}
</${call}Request>`;
  assertTrading(call, "any");
  const res = await fetch(`${ebayHosts(env).api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": call,
      "X-EBAY-API-SITEID": env.EBAY_SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-IAF-TOKEN": await userToken(env),
      "Content-Type": "text/xml",
    },
    body,
  });
  return parseTradingResponse(call, await res.text());
}

/**
 * Sends a Trading verb with a file attached (multipart: the XML request, then the bytes), as eBay's picture
 * upload needs. Only src/ebay/write.ts may call it (enforced by test), like tradingRequest.
 */
export async function tradingUpload(env: Env, call: string, innerXml: string, bytes: Uint8Array, filename: string): Promise<any> {
  assertTrading(call, "any");
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_GB</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${innerXml}
</${call}Request>`;
  const boundary = `ebaymanager${crypto.randomUUID().replace(/-/g, "")}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml;charset=utf-8\r\n\r\n${xml}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="dummy"; filename="${filename.replace(/[^\w.-]/g, "")}"\r\nContent-Type: image/jpeg\r\nContent-Transfer-Encoding: binary\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const res = await fetch(`${ebayHosts(env).api}/ws/api.dll`, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": call,
      "X-EBAY-API-SITEID": env.EBAY_SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-IAF-TOKEN": await userToken(env),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body as BodyInit,
  });
  return parseTradingResponse(call, await res.text());
}

/**
 * Uploads one listing photo to eBay Picture Services through the Media API (its image-from-file upload: the
 * JPEG as multipart form key "image") and returns its eBay address, for a Trading listing's PictureDetails.PictureURL.
 * Needs the full sell.inventory permission. Only src/ebay/write.ts may call it (enforced by test), while
 * applying an approved create_listing. It replaced the Trading picture upload on production, which eBay has
 * retired there (src/ebay/write.ts, uploadPictures).
 */
export async function mediaUpload(env: Env, bytes: Uint8Array, filename: string): Promise<string> {
  const host = ebayHosts(env).media;
  if (!host) throw new Error("eBay's Media API has no Sandbox address");
  const url = host + REST_WRITE[0].prefix;
  assertRest("POST", url, "write");
  const token = await userToken(env);
  const form = new FormData();
  form.append("image", new Blob([bytes as BlobPart], { type: "image/jpeg" }), filename.replace(/[^\w.-]/g, "") || "photo.jpg");
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, body: form });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const why = [body?.errors ?? []].flat().map((e: any) => e?.longMessage ?? e?.message).filter(Boolean).join("; ") || text.slice(0, 200);
    throw new Error(`eBay's picture upload failed (${res.status}): ${why}`);
  }
  let imageUrl = String(body?.imageUrl ?? "");
  // The reply normally holds the address; if not, the Location header names the image to read it from.
  const location = res.headers.get("Location");
  if (!/^https:\/\//.test(imageUrl) && location) {
    const read = new URL(location, host).toString();
    assertRest("GET", read);
    const got = await fetch(read, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    imageUrl = String(((await got.json().catch(() => null)) as any)?.imageUrl ?? "");
  }
  if (!/^https:\/\//.test(imageUrl)) throw new Error("eBay returned no picture address");
  return imageUrl;
}

export function parseTradingResponse(call: string, xml: string): any {
  const doc = parser.parse(xml)[`${call}Response`];
  if (!doc) throw new Error(`Unexpected Trading response for ${call}: ${xml.slice(0, 300)}`);
  if (doc.Ack === "Failure") {
    const errs = [doc.Errors].flat().map((e: any) => e?.LongMessage ?? e?.ShortMessage);
    throw new Error(`${call} failed: ${errs.join("; ")}`);
  }
  return doc;
}

export interface ActiveListing {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  quantityAvailable: number;
  watchCount: number;
  startTime: string;
  url: string;
  /** The listing's main picture on eBay's picture host, or null. */
  imageUrl: string | null;
}

/**
 * The main picture of a listing from what GetMyeBaySelling already returns (PictureDetails), so finding it costs
 * no extra eBay call. Only https addresses on eBay's picture hosts are kept (the app fetches only from those,
 * src/ebay/pictures.ts), and the small gallery size is swapped for a 500px one, which eBay serves at the same address.
 */
export function listingImage(item: any): string | null {
  const pd = item?.PictureDetails ?? {};
  const first = [pd.GalleryURL, ...[pd.PictureURL ?? []].flat()].map((u) => String(u ?? "").trim()).find(Boolean);
  if (!first) return null;
  let url: URL;
  try {
    url = new URL(first);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !isEbayPictureHost(url.hostname)) return null;
  url.pathname = url.pathname.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)$/i, "/s-l500.$1");
  return url.toString();
}

export function toActiveListing(item: any, web = PRODUCTION_HOSTS.web): ActiveListing {
  const price = item.SellingStatus?.CurrentPrice ?? item.BuyItNowPrice;
  return {
    itemId: String(item.ItemID),
    title: String(item.Title ?? ""),
    price: Number(price?.["#text"] ?? price ?? 0),
    currency: String(price?.["@_currencyID"] ?? ""),
    quantityAvailable: Number(item.QuantityAvailable ?? item.Quantity ?? 0),
    watchCount: Number(item.WatchCount ?? 0),
    startTime: String(item.ListingDetails?.StartTime ?? ""),
    url: String(item.ListingDetails?.ViewItemURL ?? `${web}/itm/${item.ItemID}`),
    imageUrl: listingImage(item),
  };
}

/** Every active listing on the account, across pages. */
export async function getActiveListings(env: Env): Promise<ActiveListing[]> {
  const out: ActiveListing[] = [];
  for (let page = 1; ; page++) {
    const doc = await trading(
      env,
      "GetMyeBaySelling",
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList>
       <DetailLevel>ReturnAll</DetailLevel>`,
    );
    const items = [doc.ActiveList?.ItemArray?.Item ?? []].flat();
    out.push(...items.map((i) => toActiveListing(i, ebayHosts(env).web)));
    const pages = Number(doc.ActiveList?.PaginationResult?.TotalNumberOfPages ?? 1);
    if (page >= pages) return out;
  }
}

/**
 * Why eBay would refuse a title or description change right now, or null. eBay blocks both on a fixed-price
 * listing with an open Best Offer (including K's own counter awaiting the buyer) or any quantity sold.
 * `openOffers` is the count of offers still open (openOfferCount). GetItem's BestOfferCount is NOT used: it
 * counts every offer the listing ever had, declined and expired ones too, so it locked listings with only old
 * offers (K's Maono listing, 2026-11-07).
 */
export function titleLockReason(item: any, openOffers = 0): string | null {
  if (openOffers > 0)
    return "this listing has an offer waiting for an answer, and eBay won't change its title or description until the offer is answered or expires";
  if (Number(item?.SellingStatus?.QuantitySold ?? 0) > 0) return "this listing has a sale, and eBay won't change its title or description";
  return null;
}

/** Offers on a listing that are still open: the buyer's waiting for K, or K's counter waiting for the buyer. */
export function openOfferCount(doc: any, now = Date.now()): number {
  const items = [doc?.ItemBestOffersArray?.ItemBestOffers ?? []].flat();
  return items
    .flatMap((ib: any) => [ib?.BestOfferArray?.BestOffer ?? []].flat())
    .filter((o: any) => ["Active", "Pending", "Countered"].includes(String(o?.Status ?? o?.BestOfferStatus ?? "")))
    .filter((o: any) => {
      const exp = Date.parse(o?.ExpirationTime ?? "");
      return !exp || exp > now;
    }).length;
}

/**
 * The title lock for one listing, asking eBay for its open offers (GetBestOffers, a read). If that call fails,
 * no lock is assumed: eBay itself refuses a revision it can't make, and the refusal is recorded.
 */
export async function titleLock(env: Env, itemId: string, item?: any): Promise<string | null> {
  const detail = item ?? (await getItem(env, itemId).catch(() => null));
  const offers = await trading(env, "GetBestOffers", `<ItemID>${esc(itemId)}</ItemID><BestOfferStatus>All</BestOfferStatus>`).catch(() => null);
  return titleLockReason(detail, offers ? openOfferCount(offers) : 0);
}

/** Full detail for one listing: description, item specifics, pictures, condition. */
export async function getItem(env: Env, itemId: string): Promise<any> {
  const doc = await trading(
    env,
    "GetItem",
    `<ItemID>${esc(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics><IncludeWatchCount>true</IncludeWatchCount>`,
  );
  return doc.Item;
}
