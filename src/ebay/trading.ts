import { XMLParser } from "fast-xml-parser";
import type { Env } from "../env";
import { userToken } from "./auth";
import { assertTrading, TRADING_READ } from "./allowlist";
import { ebayHosts, PRODUCTION_HOSTS } from "./hosts";

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
 * listing with a pending Best Offer (including K's own counter awaiting the buyer) or any quantity sold.
 */
export function titleLockReason(item: any): string | null {
  if (Number(item?.BestOfferDetails?.BestOfferCount ?? 0) > 0)
    return "this listing has a pending offer, and eBay won't change its title or description until the offer is answered or expires";
  if (Number(item?.SellingStatus?.QuantitySold ?? 0) > 0) return "this listing has a sale, and eBay won't change its title or description";
  return null;
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
