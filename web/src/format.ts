import type { Proposal } from "./api";

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
export const money = (n: number | null | undefined) => (n == null || Number.isNaN(Number(n)) ? "" : gbp.format(Number(n)));

const rtf = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
export function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

export const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

/** One line saying what a proposal will change, and the figure that goes on the right of its row. */
export function describe(p: Proposal): { what: string; figure: string } {
  const a = p.payload ?? {};
  switch (p.kind) {
    case "price":
      return { what: a.oldPrice != null ? `Price ${money(a.oldPrice)} to ${money(a.newPrice)}` : `Set price`, figure: money(a.newPrice) };
    case "revise": {
      const parts = [a.title && "title", a.description && "description", a.itemSpecifics && "item specifics"].filter(Boolean);
      const offer = typeof a.bestOfferEnabled === "boolean" ? `Best Offer ${a.bestOfferEnabled ? "on" : "off"}` : "";
      return { what: parts.length ? `New ${parts.join(", ")}${offer ? `, ${offer}` : ""}` : `Turn ${offer}`, figure: "" };
    }
    case "create_listing":
      return { what: `List ${a.title}${a.collectionOnly ? ", collection only" : ""}`, figure: money(a.price) };
    case "message":
      return { what: `Reply to ${a.recipientId ?? "a buyer"}`, figure: "" };
    case "best_offer_response": {
      const verb = a.action === "accept" ? "Accept" : a.action === "decline" ? "Decline" : "Counter";
      return { what: `${verb} an offer of ${money(a.offerPrice)}`, figure: a.action === "counter" ? money(a.counterPrice) : money(a.offerPrice) };
    }
    case "promote":
      return { what: a.action === "end" ? "End the promotion" : `Promote at ${a.rate}%`, figure: a.rate != null ? `${a.rate}%` : "" };
    case "policy":
      return { what: `Return policy: ${a.name ?? ""}`, figure: "" };
    default:
      return { what: p.kind.replace(/_/g, " "), figure: "" };
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
