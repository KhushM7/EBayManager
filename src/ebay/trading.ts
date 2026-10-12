import { XMLParser } from "fast-xml-parser";
import type { Env } from "../env";
import { userToken } from "./auth";

const COMPAT_LEVEL = "1349";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Calls a Trading API verb and returns the parsed `<Verb>Response` element. */
export async function trading(env: Env, call: string, innerXml: string): Promise<any> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_GB</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${innerXml}
</${call}Request>`;
  const res = await fetch("https://api.ebay.com/ws/api.dll", {
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

export function toActiveListing(item: any): ActiveListing {
  const price = item.SellingStatus?.CurrentPrice ?? item.BuyItNowPrice;
  return {
    itemId: String(item.ItemID),
    title: String(item.Title ?? ""),
    price: Number(price?.["#text"] ?? price ?? 0),
    currency: String(price?.["@_currencyID"] ?? ""),
    quantityAvailable: Number(item.QuantityAvailable ?? item.Quantity ?? 0),
    watchCount: Number(item.WatchCount ?? 0),
    startTime: String(item.ListingDetails?.StartTime ?? ""),
    url: String(item.ListingDetails?.ViewItemURL ?? `https://www.ebay.co.uk/itm/${item.ItemID}`),
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
    out.push(...items.map(toActiveListing));
    const pages = Number(doc.ActiveList?.PaginationResult?.TotalNumberOfPages ?? 1);
    if (page >= pages) return out;
  }
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

/** Changes a fixed-price listing's price. Only ever called from an approved proposal. */
export async function revisePrice(env: Env, itemId: string, price: number): Promise<void> {
  await trading(
    env,
    "ReviseFixedPriceItem",
    `<Item><ItemID>${esc(itemId)}</ItemID><StartPrice>${price.toFixed(2)}</StartPrice></Item>`,
  );
}
