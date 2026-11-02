import type { Env } from "../env";
import type { Proposal } from "../proposals";
import { RETURNS } from "../rules";
import { esc, tradingRequest } from "./trading";

// The write gate. This is the only module that may send an eBay write (enforced by test/safety.test.ts).
// It reads the proposal's state from D1 itself, so a caller can't talk it into applying something.

export class WriteRefused extends Error {}

export async function writesPaused(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'writes_paused'").first<{ value: string }>();
  return row?.value === "1";
}

export async function setWritesPaused(env: Env, paused: boolean): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('writes_paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(paused ? "1" : "0")
    .run();
}

interface WriteCall {
  call: string;
  xml: string;
}

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
      ].join("");
      if (!fields) throw new Error("Revision has no title, description or item specifics");
      return { call: "ReviseFixedPriceItem", xml: `<Item><ItemID>${esc(p.item_id!)}</ItemID>${fields}</Item>` };
    }
    case "create_listing": {
      const pictures = (a.pictureUrls ?? []).map((u: string) => `<PictureURL>${esc(u)}</PictureURL>`).join("");
      const shipping = a.collectionOnly
        ? `<ShippingService>UK_CollectInPerson</ShippingService><ShippingServiceCost currencyID="GBP">0.00</ShippingServiceCost>`
        : `<ShippingService>UK_RoyalMailSecondClassStandard</ShippingService><ShippingServiceCost currencyID="GBP">${Number(a.shippingCost ?? 0).toFixed(2)}</ShippingServiceCost>`;
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
  ${pictures ? `<PictureDetails>${pictures}</PictureDetails>` : ""}
  ${specificsXml(a.itemSpecifics)}
  <ReturnPolicy><ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption><ReturnsWithinOption>Days_${RETURNS.periodDays}</ReturnsWithinOption><ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption></ReturnPolicy>
  <ShippingDetails><ShippingType>Flat</ShippingType><ShippingServiceOptions><ShippingServicePriority>1</ShippingServicePriority>${shipping}</ShippingServiceOptions></ShippingDetails>
</Item>`,
      };
    }
    default:
      throw new WriteRefused(`Applying ${p.kind} is not built yet`);
  }
}

async function audit(env: Env, proposalId: string, call: string, request: string, outcome: string, response: string) {
  await env.DB.prepare(
    "INSERT INTO audit_log (at, env, proposal_id, call, request, response, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(Date.now(), env.EBAY_ENV, proposalId, call, request.slice(0, 8000), response.slice(0, 8000), outcome)
    .run();
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
  const p = await env.DB.prepare("SELECT * FROM proposals WHERE id = ?").bind(proposalId).first<Proposal>();
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
  const claimed = closed
    ? null
    : await env.DB.prepare("UPDATE proposals SET status = 'applying' WHERE id = ? AND status = 'approved' AND dry_run = 0")
        .bind(p.id)
        .run();
  if (closed || !claimed?.meta.changes) {
    const reason = closed ?? (p.dry_run ? "Dry-run proposal" : `Proposal is ${p.status}, not approved`);
    await audit(env, p.id, built.call, built.xml, "refused", reason);
    throw new WriteRefused(reason);
  }

  try {
    const res = await tradingRequest(env, built.call, built.xml);
    const summary = res.ItemID ? `${built.call} ok, item ${res.ItemID}` : `${built.call} ok`;
    await audit(env, p.id, built.call, built.xml, "applied", JSON.stringify(res));
    return summary;
  } catch (e) {
    await audit(env, p.id, built.call, built.xml, "failed", e instanceof Error ? e.message : String(e));
    throw e;
  }
}
