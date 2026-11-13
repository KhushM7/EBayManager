import type { Env } from "./env";
import { recordFailure, watched } from "./services";

// Postage quotes for a new listing (docs/add-listing.md, K's choice on 2026-11-05): the Parcel2Go Quoting API,
// kept to the carriers eBay uses for Simple Delivery (Evri, Royal Mail, DHL, InPost), cheapest first.
//
// From Parcel2Go's API docs (read 2026-11-05, https://www.parcel2go.com/api/docs/): OAuth2 client credentials
// at POST /auth/connect/token (form fields grant_type, scope=public-api, client_id, client_secret; token in
// "access_token", lifetime in seconds in "expires_in"), then POST /api/quotes with
// { CollectionAddress: { Country: "GBR" }, DeliveryAddress: { Country: "GBR" }, Parcels: [{ Value, Weight,
// Length, Width, Height }] } and a Bearer token; the reply has a "Quotes" list. Live base www.parcel2go.com,
// sandbox base sandbox.parcel2go.com, with separate credentials.
//
// Each quote's fields were checked against real live replies on 2026-11-06 (scripts/parcel2go-quote.mjs, 34 to
// 41 quotes a parcel in about 3 s): Service.CourierName ("Royal Mail", "Evri Drop-off", "InPost"), Service.Name
// ("Royal Mail 48 Tracked Small"), TotalPrice (pounds, VAT included, what K would pay), CurrencyCode "GBP".
// K's credentials are live ones (the sandbox API refuses them), and quoting is free and books nothing.

/** readQuote() is checked against a real Parcel2Go reply (2026-11-06). */
export const QUOTE_FORMAT_CONFIRMED = true;

/** The carriers eBay uses for Simple Delivery (K, 2026-11-05). */
export const SIMPLE_DELIVERY_CARRIERS = ["Evri", "Royal Mail", "DHL", "InPost"] as const;

export interface Quote {
  carrier: string;
  service: string;
  price: number;
}

const base = (env: Env) => (env.PARCEL2GO_SANDBOX === "true" ? "https://sandbox.parcel2go.com" : "https://www.parcel2go.com");

let token: { value: string; until: number; base: string } | null = null;

async function accessToken(env: Env): Promise<string> {
  const b = base(env);
  if (token && token.base === b && token.until > Date.now() + 60_000) return token.value;
  const res = await watched(env, "parcel2go", () =>
    fetch(`${b}/auth/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "public-api", client_id: env.PARCEL2GO_CLIENT_ID!, client_secret: env.PARCEL2GO_CLIENT_SECRET! }),
    }),
  );
  if (!res.ok) {
    const err = new Error(`Parcel2Go sign-in failed (${res.status})`);
    // An OAuth server answers wrong credentials with 400 invalid_client: a sign-in to fix, not a passing fault.
    if (res.status === 400) await recordFailure(env, "parcel2go", "auth", err);
    throw err;
  }
  const data: any = await res.json();
  if (!data.access_token) throw new Error("Parcel2Go sign-in returned no token");
  token = { value: String(data.access_token), until: Date.now() + Number(data.expires_in ?? 600) * 1000, base: b };
  return token.value;
}

/** Which Simple Delivery carrier a courier name belongs to, if any ("Royal Mail Tracked 48" -> "Royal Mail"). */
export function simpleDeliveryCarrier(name: string): (typeof SIMPLE_DELIVERY_CARRIERS)[number] | null {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  if (n.includes("evri") || n.includes("hermes")) return "Evri";
  if (n.includes("royalmail")) return "Royal Mail";
  if (n.includes("dhl")) return "DHL";
  if (n.includes("inpost")) return "InPost";
  return null;
}

/** eBay's Simple Delivery carriers only, cheapest first. */
export function cheapestSimpleDelivery(quotes: Quote[]): Quote[] {
  return quotes
    .map((q) => ({ ...q, carrier: simpleDeliveryCarrier(q.carrier) ?? "" }))
    .filter((q) => q.carrier && Number.isFinite(q.price) && q.price > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, 6);
}

/** One quote from Parcel2Go's reply: the courier, the service and the total price in pounds, VAT included. */
export function readQuote(raw: any): Quote | null {
  const carrier = typeof raw?.Service?.CourierName === "string" ? raw.Service.CourierName.trim().slice(0, 40) : "";
  const service = typeof raw?.Service?.Name === "string" ? raw.Service.Name.trim().slice(0, 80) : "";
  const price = Number(raw?.TotalPrice);
  if (!carrier || !service || !(price > 0 && price < 1000)) return null;
  if (raw?.CurrencyCode && raw.CurrencyCode !== "GBP") return null;
  return { carrier, service, price: Math.round(price * 100) / 100 };
}

/** Every courier, cheapest first: for a parcel too big or heavy for Simple Delivery (DPD, Parcelforce, UPS...). */
export function cheapestAnyCourier(quotes: Quote[]): Quote[] {
  return quotes.filter((q) => Number.isFinite(q.price) && q.price > 0).sort((a, b) => a.price - b.price).slice(0, 6);
}

/**
 * Live quotes for a parcel sent within the UK, cheapest first: eBay's Simple Delivery carriers only, or (anyCourier)
 * every courier, for parcels Simple Delivery can't take.
 */
export async function parcelQuotes(env: Env, p: Parcel, valueGbp: number, opts: { anyCourier?: boolean } = {}): Promise<Quote[]> {
  if (!env.PARCEL2GO_CLIENT_ID || !env.PARCEL2GO_CLIENT_SECRET) throw new Error("Postage quotes aren't set up yet (Parcel2Go credentials). Type the postage for now.");
  if (!QUOTE_FORMAT_CONFIRMED) throw new Error("Postage quotes are waiting for Parcel2Go's quote format to be checked on their sandbox. Type the postage for now.");
  const bearer = await accessToken(env);
  const res = await watched(env, "parcel2go", () =>
    fetch(`${base(env)}/api/quotes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        CollectionAddress: { Country: "GBR" },
        DeliveryAddress: { Country: "GBR" },
        Parcels: [{ Value: Math.max(1, Math.round(valueGbp)), Weight: p.weightKg, Length: p.lengthCm, Width: p.widthCm, Height: p.heightCm }],
      }),
    }),
  );
  if (!res.ok) throw new Error(`Parcel2Go quote failed (${res.status})`);
  const data: any = await res.json();
  const quotes = (Array.isArray(data?.Quotes) ? data.Quotes : []).map(readQuote).filter((q: Quote | null): q is Quote => q != null);
  return opts.anyCourier ? cheapestAnyCourier(quotes) : cheapestSimpleDelivery(quotes);
}

// ---------------------------------------------------------------- Simple Delivery parcel sizes
//
// The sizes eBay UK offers a seller choosing "Buyer pays postage" (Simple Delivery), exactly as eBay's listing
// form showed them to K on 2026-11-06 (K's screenshot, an air fryer: eBay recommended Medium parcel, up to 10 kg).
// eBay's help page lists only carrier limits, not these choices. Simple Delivery can't be set through eBay's API
// (eBay developer support), so K switches a listing to it in Seller Hub after it's published, choosing this size;
// the app files that as an Inbox to-do. Picking a size too small costs K the difference plus a £1 fee at the post
// office, so the choice errs larger: the parcel must fit every side, and its weight stays 5% under the band.

export interface Parcel {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
}

export interface ParcelSize {
  code: string;
  /** eBay's group, as on its form. */
  group: "Large letter" | "Small parcel" | "Medium parcel";
  /** The option, as on eBay's form. */
  label: string;
  maxCm: [number, number, number];
  maxKg: number;
}

export const PARCEL_SIZES: ParcelSize[] = [
  { code: "large_letter_1kg", group: "Large letter", label: "Up to 1 kg large letter", maxCm: [35, 25, 2.5], maxKg: 1 },
  { code: "small_parcel_1kg", group: "Small parcel", label: "Up to 1 kg", maxCm: [45, 35, 16], maxKg: 1 },
  { code: "small_parcel_2kg", group: "Small parcel", label: "Up to 2 kg", maxCm: [45, 35, 16], maxKg: 2 },
  { code: "medium_parcel_1kg", group: "Medium parcel", label: "Up to 1 kg", maxCm: [61, 46, 46], maxKg: 1 },
  { code: "medium_parcel_2kg", group: "Medium parcel", label: "Up to 2 kg", maxCm: [61, 46, 46], maxKg: 2 },
  { code: "medium_parcel_10kg", group: "Medium parcel", label: "Up to 10 kg", maxCm: [61, 46, 46], maxKg: 10 },
  { code: "medium_parcel_20kg", group: "Medium parcel", label: "Up to 20 kg", maxCm: [61, 46, 46], maxKg: 20 },
];

/** Simple Delivery takes items priced up to this (eBay help, 2026-11-06); dearer items need their own postage. */
export const SIMPLE_DELIVERY_MAX_PRICE = 750;
/** The weight is kept this far under a band's limit, for scales and tape. */
export const WEIGHT_MARGIN = 0.05;

export const sizeName = (z: ParcelSize) => `${z.group}, ${z.label.replace(" large letter", "").toLowerCase()}`;

/** Whether the parcel fits a size: each side, longest against longest, and its weight with the margin. */
export function fitsSize(p: Parcel, z: ParcelSize): boolean {
  const sides = [p.lengthCm, p.widthCm, p.heightCm].sort((a, b) => b - a);
  const max = [...z.maxCm].sort((a, b) => b - a);
  return sides.every((x, i) => x <= max[i]) && p.weightKg * (1 + WEIGHT_MARGIN) <= z.maxKg;
}

/**
 * The size to choose on eBay's form: the first that fits, in eBay's order (smallest first). Null when nothing
 * fits (bigger than a medium parcel, or over 20 kg): then it needs a courier and its own postage price.
 */
export function recommendSize(p: Parcel): ParcelSize | null {
  return PARCEL_SIZES.find((z) => fitsSize(p, z)) ?? null;
}

export const sizeByCode = (code: string | null | undefined) => PARCEL_SIZES.find((z) => z.code === code) ?? null;

