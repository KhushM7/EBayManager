import type { Env } from "../env";
import type { Proposal } from "../proposals";
import { PROMOTION_RATE, RETURNS, WATCHER_OFFER } from "../rules";
import { EbayCallError, esc, mediaUpload, restWrite, tradingRequest, tradingUpload } from "./trading";
import { getCampaigns, getPromotedListings } from "./sell";
import { ebayHosts } from "./hosts";
import { seqId } from "../store/doc";

// The write gate. This is the only module that may send an eBay write (enforced by test/safety.test.ts).
// It reads the proposal's state from the store itself, so a caller can't talk it into applying something.

export class WriteRefused extends Error {}

export async function writesPaused(env: Env): Promise<boolean> {
  return (await env.store.kv.get("writes_paused")) === "1";
}

export async function setWritesPaused(env: Env, paused: boolean): Promise<void> {
  await env.store.kv.set("writes_paused", paused ? "1" : "0");
}

interface WriteCall {
  call: string;
  /** What is sent, for the audit log: Trading XML, or the JSON of a REST call. */
  xml: string;
  /** A single REST write (Negotiation API), instead of a Trading call. */
  rest?: { method: "POST"; path: string; body: unknown };
  /** A Promoted Listings change: several REST calls, worked out when applied (applyPromotion). */
  promote?: { action: "promote" | "lower" | "end"; rate: number | null };
}

/** The app's own Promoted Listings campaign: general (cost per sale), one for every listing it promotes. */
export const CAMPAIGN_NAME = "EBayManager general";

const bestOfferXml = (on: unknown) =>
  typeof on === "boolean" ? `<BestOfferDetails><BestOfferEnabled>${on}</BestOfferEnabled></BestOfferDetails>` : "";

const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;

function specificsXml(specifics: Record<string, string | string[]> | undefined): string {
  if (!specifics || !Object.keys(specifics).length) return "";
  const lists = Object.entries(specifics).map(
    ([name, values]) =>
      `<NameValueList><Name>${esc(name)}</Name>${[values].flat().map((v) => `<Value>${esc(String(v))}</Value>`).join("")}</NameValueList>`,
  );
  return `<ItemSpecifics>${lists.join("")}</ItemSpecifics>`;
}

/** Builds the eBay call for a proposal. Kinds without a builder can be approved but not applied yet. */
export function callFor(p: Pick<Proposal, "kind" | "item_id" | "payload">): WriteCall {
  const a = JSON.parse(p.payload);
  switch (p.kind) {
    case "price":
      return {
        call: "ReviseFixedPriceItem",
        xml: `<Item><ItemID>${esc(p.item_id!)}</ItemID><StartPrice>${Number(a.newPrice).toFixed(2)}</StartPrice></Item>`,
      };
    case "revise": {
      const fields = [
        a.title ? `<Title>${esc(a.title)}</Title>` : "",
        a.description ? `<Description>${cdata(a.description)}</Description>` : "",
        specificsXml(a.itemSpecifics),
        bestOfferXml(a.bestOfferEnabled),
      ].join("");
      if (!fields) throw new Error("Revision has no title, description, item specifics or Best Offer setting");
      return { call: "ReviseFixedPriceItem", xml: `<Item><ItemID>${esc(p.item_id!)}</ItemID>${fields}</Item>` };
    }
    case "create_listing": {
      const pictures = (a.pictureUrls ?? []).map((u: string) => `<PictureURL>${esc(u)}</PictureURL>`).join("");
      // eBay rejects collection in person as the only flat-rate service; collection only = no postage, ship nowhere.
      // Collection offered as well as postage is a second, free service.
      const collect = a.collectionOffered
        ? `<ShippingServiceOptions><ShippingServicePriority>2</ShippingServicePriority><ShippingService>UK_CollectInPerson</ShippingService><ShippingServiceCost currencyID="GBP">0.00</ShippingServiceCost></ShippingServiceOptions>`
        : "";
      const shipping = a.collectionOnly
        ? `<ShipToLocations>None</ShipToLocations>`
        : `<ShippingDetails><ShippingType>Flat</ShippingType><ShippingServiceOptions><ShippingServicePriority>1</ShippingServicePriority><ShippingService>UK_RoyalMailSecondClassStandard</ShippingService><ShippingServiceCost currencyID="GBP">${Number(a.shippingCost ?? 0).toFixed(2)}</ShippingServiceCost></ShippingServiceOptions>${collect}</ShippingDetails>`;
      return {
        call: "AddFixedPriceItem",
        xml: `<Item>
  <Title>${esc(a.title)}</Title>
  <Description>${cdata(a.description)}</Description>
  <PrimaryCategory><CategoryID>${esc(String(a.categoryId))}</CategoryID></PrimaryCategory>
  <StartPrice currencyID="GBP">${Number(a.price).toFixed(2)}</StartPrice>
  <ConditionID>${esc(String(a.conditionId))}</ConditionID>
  <Quantity>${Number(a.quantity ?? 1)}</Quantity>
  <Country>GB</Country><Currency>GBP</Currency><Site>UK</Site>
  <PostalCode>${esc(a.postcode)}</PostalCode>
  <DispatchTimeMax>2</DispatchTimeMax><ListingDuration>GTC</ListingDuration><ListingType>FixedPriceItem</ListingType>
  ${bestOfferXml(a.bestOffer === true ? true : undefined)}
  ${pictures ? `<PictureDetails>${pictures}</PictureDetails>` : ""}
  ${specificsXml(a.itemSpecifics)}
  <ReturnPolicy><ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption><ReturnsWithinOption>Days_${RETURNS.periodDays}</ReturnsWithinOption><ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption></ReturnPolicy>
  ${shipping}
</Item>`,
      };
    }
    case "message": {
      const body = String(a.body ?? "").trim();
      if (!body) throw new WriteRefused("The reply is empty. Write it in the Inbox before approving.");
      return {
        call: "AddMemberMessageRTQ",
        xml: `<ItemID>${esc(p.item_id!)}</ItemID><MemberMessage><Body>${esc(body.slice(0, 2000))}</Body><ParentMessageID>${esc(
          String(a.parentMessageId),
        )}</ParentMessageID><RecipientID>${esc(String(a.recipientId))}</RecipientID></MemberMessage>`,
      };
    }
    case "best_offer_response": {
      const action = a.action === "accept" ? "Accept" : a.action === "decline" ? "Decline" : a.action === "counter" ? "Counter" : null;
      if (!action) throw new WriteRefused(`Unknown offer action ${a.action}`);
      if (action === "Counter" && !(Number(a.counterPrice) > 0)) throw new WriteRefused("A counter-offer needs a price.");
      return {
        call: "RespondToBestOffer",
        xml: `<ItemID>${esc(p.item_id!)}</ItemID><BestOfferID>${esc(String(a.bestOfferId))}</BestOfferID><Action>${action}</Action>${
          a.message ? `<SellerResponse>${esc(String(a.message).slice(0, 250))}</SellerResponse>` : ""
        }${
          action === "Counter"
            ? `<CounterOfferPrice currencyID="GBP">${Number(a.counterPrice).toFixed(2)}</CounterOfferPrice><CounterOfferQuantity>1</CounterOfferQuantity>`
            : ""
        }`,
      };
    }
    case "offer_to_watchers": {
      // K's rule, enforced here: a small reminder discount only (WATCHER_OFFER), whatever the proposal says.
      const percent = Number(a.percent);
      if (!(percent >= WATCHER_OFFER.minPercent && percent <= WATCHER_OFFER.maxPercent))
        throw new WriteRefused(`An offer to watchers must be ${WATCHER_OFFER.minPercent}% to ${WATCHER_OFFER.maxPercent}% off, not ${a.percent}%.`);
      if (!p.item_id) throw new WriteRefused("An offer to watchers needs a listing.");
      const body = {
        allowCounterOffer: false,
        message: String(a.message ?? "").slice(0, 2000),
        offerDuration: { unit: "DAY", value: WATCHER_OFFER.durationDays },
        offeredItems: [{ listingId: p.item_id, quantity: 1, discountPercentage: String(percent) }],
      };
      return { call: "sendOfferToInterestedBuyers", xml: JSON.stringify(body), rest: { method: "POST", path: "/sell/negotiation/v1/send_offer_to_interested_buyers", body } };
    }
    case "promote": {
      const action = a.action === "promote" || a.action === "lower" || a.action === "end" ? a.action : null;
      if (!action) throw new WriteRefused(`Unknown promotion action ${a.action}`);
      if (!p.item_id) throw new WriteRefused("A promotion needs a listing.");
      const rate = action === "end" ? null : Number(a.rate);
      if (rate != null && !(rate >= PROMOTION_RATE.min && rate <= PROMOTION_RATE.max))
        throw new WriteRefused(`An ad rate must be ${PROMOTION_RATE.min}% to ${PROMOTION_RATE.max}%, not ${a.rate}%.`);
      return { call: "promote", xml: JSON.stringify({ action, rate, listingId: p.item_id }), promote: { action, rate } };
    }
    default:
      throw new WriteRefused(`Applying ${p.kind} is not built yet`);
  }
}

/**
 * Asks eBay to check a new listing without creating it (VerifyAddFixedPriceItem), so K is never asked to
 * approve a listing eBay will reject. Changes nothing on eBay, so it needs no approval. Throws eBay's errors.
 */
export async function verifyNewListing(env: Env, payload: unknown): Promise<{ fees: number }> {
  const { xml } = callFor({ kind: "create_listing", item_id: null, payload: JSON.stringify(payload) });
  const res = await tradingRequest(env, "VerifyAddFixedPriceItem", xml);
  const fees = [res.Fees?.Fee ?? []].flat().reduce((sum: number, f: any) => sum + Number(f.Fee?.["#text"] ?? f.Fee ?? 0), 0);
  return { fees: Math.round(fees * 100) / 100 };
}

/** What went wrong, for the audit log: the message, and for a REST call eBay's status, request id and whole reply. */
const failure = (e: unknown) =>
  e instanceof EbayCallError
    ? `${e.message}\nHTTP ${e.status}${e.requestId ? `, eBay request id ${e.requestId}` : ""}\nRaw reply: ${e.raw || "(empty)"}`
    : e instanceof Error
      ? e.message
      : String(e);

async function audit(env: Env, proposalId: string, call: string, request: string, outcome: string, response: string) {
  // Who approved it (read now, after the decision), what kind of change and for which item, for Activity.
  const p = await env.store.proposals.get(proposalId);
  const at = Date.now();
  await env.store.audit.record(
    {
      at,
      env: env.EBAY_ENV,
      proposal_id: proposalId,
      call,
      request: request.slice(0, 8000),
      response: response.slice(0, 8000),
      outcome,
      actor: p?.decided_by ?? null,
      kind: p?.kind ?? null,
      item_id: p?.item_id ?? null,
    },
    seqId(at),
  );
}

/** Why the gate would refuse right now, before looking at the proposal; null if writes are open. */
export async function gateClosedReason(env: Env): Promise<string | null> {
  if (env.WRITE_MODE !== "approval") return `Writes are off (WRITE_MODE=${env.WRITE_MODE || "unset"})`;
  if (await writesPaused(env)) return "Writes are paused";
  return null;
}

/**
 * Applies an approved proposal to eBay. Refuses (WriteRefused, logged) unless writes are on, not paused,
 * and the proposal is approved, not a dry run, and not already applied. Claims the proposal atomically,
 * so a double tap can't apply it twice.
 */
export async function ebayWrite(env: Env, proposalId: string): Promise<string> {
  const p = (await env.store.proposals.get(proposalId)) as Proposal | null;
  if (!p) throw new WriteRefused("Proposal not found");

  let built: WriteCall;
  try {
    built = callFor(p);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit(env, p.id, p.kind, p.payload, "refused", msg);
    throw e instanceof WriteRefused ? e : new WriteRefused(msg);
  }

  const closed = await gateClosedReason(env);
  // The claim is one conditional write: approved and not a dry run -> applying, at most once.
  const claimed = closed ? false : await env.store.proposals.claimForApply(p.id);
  if (closed || !claimed) {
    const reason = closed ?? (p.dry_run ? "Dry-run proposal" : `Proposal is ${p.status}, not approved`);
    await audit(env, p.id, built.call, built.xml, "refused", reason);
    throw new WriteRefused(reason);
  }

  try {
    // A new listing from a draft: its photos go to eBay's picture service first (as uploaded bytes; they never
    // get a public address), then the listing is built with eBay's picture addresses.
    let note = "";
    if (p.kind === "create_listing") {
      const a = JSON.parse(p.payload);
      if (Array.isArray(a.photoKeys) && a.photoKeys.length) {
        const pictures = await uploadPictures(env, p.id, a.photoKeys);
        if (pictures.sandboxDown) note = " (without photos: eBay Sandbox's picture service is down)";
        built = callFor({ ...p, payload: JSON.stringify({ ...a, pictureUrls: pictures.urls }) });
      }
    }
    if (built.promote) return await applyPromotion(env, p.id, p.item_id!, built.promote);
    if (built.rest) {
      const res = await restWrite(env, built.rest.method, built.rest.path, built.rest.body);
      await audit(env, p.id, built.call, built.xml, "applied", JSON.stringify(res.body).slice(0, 4000));
      return `${built.call} ok`;
    }
    const res = await tradingRequest(env, built.call, built.xml);
    const summary = (res.ItemID ? `${built.call} ok, item ${res.ItemID}` : `${built.call} ok`) + note;
    await audit(env, p.id, built.call, built.xml, "applied", JSON.stringify(res));
    if (p.kind === "revise" && p.item_id) {
      const a = JSON.parse(p.payload);
      if (typeof a.title === "string" && a.title) await env.store.listings.retitleSpecs(p.item_id, a.title).catch(() => null);
    }
    if (p.kind === "create_listing" && res.ItemID) {
      const a = JSON.parse(p.payload);
      if (typeof a.draftId === "string") {
        await env.store.drafts.setStatus(a.draftId, "published", Date.now(), { item_id: String(res.ItemID), published_at: Date.now() }).catch(() => null);
        // The draft's published specs (looked up for the exact product) carry over to the live listing, so its
        // first review doesn't pay for the same web search again.
        const d = await env.store.drafts.get(a.draftId).catch(() => null);
        if (d?.specs?.exact && d.specs.specs.length) {
          const itemId = String(res.ItemID);
          const title = String(a.title ?? "");
          await env.store.listings.putSpecs(itemId, title, Date.now(), JSON.stringify({ itemId, title, at: Date.now(), ...d.specs, dropped: 0, costUsd: 0 })).catch(() => null);
        }
      }
      // What K does next in Seller Hub (Simple Delivery can't be set through the API): an Inbox to-do, not a write.
      const t = a.afterPublish;
      if (t && typeof t.code === "string" && typeof t.title === "string")
        await env.store.todos
          .sync("listing", { codes: [t.code], itemIds: [String(res.ItemID)] }, [{ code: t.code, kind: "you", itemId: String(res.ItemID), itemTitle: String(a.title ?? ""), title: String(t.title), detail: String(t.detail ?? ""), fingerprint: String(t.title) }], Date.now())
          .catch(() => null);
    }
    return summary;
  } catch (e) {
    // A promotion's own calls are already in the log, each with its outcome.
    if (!built.promote) await audit(env, p.id, built.call, built.rest ? `${built.rest.method} ${built.rest.path} ${built.xml}` : built.xml, "failed", failure(e));
    throw e;
  }
}

const lastPart = (location: string | null) => (location ? (location.split("?")[0].split("/").filter(Boolean).pop() ?? null) : null);

/**
 * Applies an approved `promote` proposal through eBay's Marketing API, only after the gate's claim. Promote:
 * the listing's ad is created in the app's general campaign (made on first use), or its rate changed if it
 * already has one. Lower: the ad's rate is changed. End: the ad is removed. Each call is in the audit log.
 */
async function applyPromotion(env: Env, proposalId: string, itemId: string, x: { action: "promote" | "lower" | "end"; rate: number | null }): Promise<string> {
  const base = "/sell/marketing/v1/ad_campaign";
  const send = async (call: string, method: "POST" | "DELETE", path: string, body?: unknown) => {
    try {
      const res = await restWrite(env, method, path, body);
      await audit(env, proposalId, call, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body)}`, "applied", res.location ?? JSON.stringify(res.body).slice(0, 2000));
      return res;
    } catch (e) {
      await audit(env, proposalId, call, `${method} ${path} ${body === undefined ? "" : JSON.stringify(body)}`, "failed", failure(e));
      throw e;
    }
  };
  const ad = (await getPromotedListings(env)).find((a) => a.listingId === itemId) ?? null;
  const bid = x.rate == null ? "" : x.rate.toFixed(1);
  const adPath = () => {
    if (!ad?.adId) throw new Error("eBay didn't give this listing's ad id, so its promotion can't be changed here. Change it in Seller Hub.");
    return `${base}/${encodeURIComponent(ad.campaignId)}/ad/${encodeURIComponent(ad.adId)}`;
  };
  if (x.action === "end") {
    if (!ad) return "The listing isn't promoted any more: nothing to end.";
    await send("deleteAd", "DELETE", adPath());
    return `Promotion ended (was ${ad.rate ?? "?"}%)`;
  }
  if (ad) {
    if (ad.rate != null && Math.abs(ad.rate - x.rate!) < 0.01) return `Already promoted at ${ad.rate}%: nothing to change.`;
    await send("updateBid", "POST", `${adPath()}/update_bid`, { bidPercentage: bid });
    return `Ad rate changed from ${ad.rate ?? "?"}% to ${x.rate}%`;
  }
  if (x.action === "lower") return "The listing isn't promoted any more: nothing to lower.";
  let campaignId = (await getCampaigns(env)).find((c) => c.campaignName === CAMPAIGN_NAME && c.fundingModel === "COST_PER_SALE")?.campaignId ?? null;
  if (!campaignId) {
    const made = await send("createCampaign", "POST", base, {
      campaignName: CAMPAIGN_NAME,
      marketplaceId: env.EBAY_MARKETPLACE,
      startDate: new Date().toISOString(),
      fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: bid },
    });
    campaignId = lastPart(made.location) ?? (made.body?.campaignId != null ? String(made.body.campaignId) : null);
    if (!campaignId) throw new Error("eBay created the campaign but didn't say its id. Approve again in a few minutes.");
  }
  await send("createAdByListingId", "POST", `${base}/${encodeURIComponent(campaignId)}/ad`, { listingId: itemId, bidPercentage: bid });
  return `Promoted at ${x.rate}% in "${CAMPAIGN_NAME}"`;
}

/**
 * Uploads a new listing's photos to eBay's picture service, sent as the image bytes, and returns eBay's
 * addresses for them, in order. Only called while applying an approved create_listing, after the gate's claim.
 * Each upload is in the audit log.
 *
 * Production uses the Media API (createImageFromFile): eBay retired Trading's UploadSiteHostedPictures there
 * (it answered "Resource not found" for K's first real listing, 2026-11-07, and its reference page is gone).
 * eBay publishes no Media API host for Sandbox, so Sandbox keeps UploadSiteHostedPictures and its fallback.
 */
async function uploadPictures(env: Env, proposalId: string, keys: string[]): Promise<{ urls: string[]; sandboxDown?: boolean }> {
  if (!env.photos) throw new Error("Photo storage isn't set up, so the listing's photos can't be sent to eBay");
  const urls: string[] = [];
  for (const [i, key] of keys.slice(0, 24).entries()) {
    const bytes = await env.photos.get(key);
    if (!bytes) throw new Error(`Photo ${i + 1} is missing from storage`);
    const media = ebayHosts(env).media !== null;
    const call = media ? "createImageFromFile" : "UploadSiteHostedPictures";
    const xml = `<PictureName>photo-${i + 1}</PictureName><PictureSet>Supersize</PictureSet>`;
    const sent = media ? `photo-${i + 1}.jpg (${bytes.length} bytes)` : xml;
    try {
      let url: string;
      if (media) url = await mediaUpload(env, bytes, `photo-${i + 1}.jpg`);
      else {
        const res = await tradingUpload(env, "UploadSiteHostedPictures", xml, bytes, `photo-${i + 1}.jpg`);
        url = String(res?.SiteHostedPictureDetails?.FullURL ?? "");
      }
      if (!/^https:\/\//.test(url)) throw new Error("eBay returned no picture address");
      urls.push(url);
      await audit(env, proposalId, call, sent, "applied", url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await audit(env, proposalId, call, sent, "failed", msg);
      // eBay Sandbox's picture service has been down since 2025 (eBay's API status page: "The
      // UploadSiteHostedPictures API call in the Sandbox environment is not working"), answering every upload with
      // error 10007. On Sandbox only, the first photo failing that way lists the item without photos, so the rest
      // of publishing can still be tested. Production always stops: a listing never goes live without its photos.
      if (env.EBAY_ENV === "sandbox" && i === 0 && /Internal error to the application/i.test(msg)) return { urls: [], sandboxDown: true };
      throw e;
    }
  }
  return { urls };
}
