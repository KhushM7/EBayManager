// Runs Add Listing end to end on the deployed Sandbox app, through its real API: photo upload to Blob
// storage, Claude's photo check, eBay's category suggestions and item specifics (Taxonomy), the listing text,
// the pricing engine, postage, and eBay's own check (VerifyAddFixedPriceItem) before the label is filed.
// It replaces the parts of K's Sandbox walk-through that a script can do; K still tries the camera and the
// screens on the phone (docs/add-listing-handover.md).
//
//   node scripts/sandbox-listing-check.mjs              stops when the label is in the Inbox
//   node scripts/sandbox-listing-check.mjs --approve    also approves it: photos go to eBay Sandbox's picture
//                                                       service and the item is listed on eBay Sandbox
//
// Sandbox only: it signs in with DASHBOARD_KEY, which the production app refuses. Costs about 10p of Claude
// and one sold-data lookup (cached for 30 days). Uses the three photos in test/fixtures-photos/.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { outputs } from "./azure-common.mjs";

const approve = process.argv.includes("--approve");
const base = outputs("sandbox").publicUrl;
if (!/sandbox/.test(base)) throw new Error(`Refusing: ${base} isn't the Sandbox app`);
const vars = parseEnv(readFileSync(".dev.vars", "utf8"));
console.log(`Add Listing on ${base}${approve ? " (with approval)" : ""}\n`);

let cookie = "";
let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
  return ok;
};
async function call(path, body, type = "application/json") {
  const res = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, "X-EbayManager": "1", ...(body === undefined ? {} : { "Content-Type": type }) },
    body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.arrayBuffer();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}
/** A background job: queued on Azure, so wait for it like the app does. */
async function job(path) {
  const first = await call(path, {});
  if (first.status !== "queued") return first;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const s = await call(`/jobs/${first.jobId}`);
    if (s.status === "done") return s.result;
    if (s.status === "failed") throw new Error(`${path}: ${s.error}`);
  }
  throw new Error(`${path}: still running after 4 minutes`);
}

const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "X-EbayManager": "1", "Content-Type": "application/json" }, body: JSON.stringify({ key: vars.DASHBOARD_KEY }) });
cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
if (!check("signed in with the Sandbox key", login.ok && cookie.length > 10)) process.exit(1);

try {
  let d = await call("/drafts", {});
  d = await call(`/drafts/${d.id}`, { title: "Sony headphones" });
  check("draft created", d.status === "open", d.id);

  for (const name of ["front", "label", "side"]) {
    const bytes = readFileSync(`test/fixtures-photos/${name}.jpg`);
    d = await call(`/drafts/${d.id}/photos?hash=${name === "front" ? "0f0f0f0f0f0f0f0f" : name === "label" ? "f0f0f0f0f0f0f0f0" : "00ff00ff00ff00ff"}`, bytes, "image/jpeg");
  }
  check("3 photos stored in Blob storage", d.photos.length === 3);
  const img = Buffer.from(await call(d.photos[0].url.replace(/^\/api/, "")));
  check("a photo is served back as a JPEG with no metadata", img[0] === 0xff && img[1] === 0xd8 && !img.includes(Buffer.from("Exif")), `${img.length} bytes`);

  d = await job(`/drafts/${d.id}/review`);
  check("Claude's photo check", Boolean(d.review?.product), `${d.review?.product}; exact: ${d.review?.exact}; ${d.review?.questions?.length ?? 0} questions; shots to add: ${d.review?.missingShots?.map((s) => s.shot).join(", ")}`);
  check("eBay suggested categories (Taxonomy)", (d.categories ?? []).length > 0, d.categories?.slice(0, 3).map((c) => c.name).join(" / "));
  check("the category's item specifics (Taxonomy aspects)", (d.aspects ?? []).length > 0, `${d.aspects?.length} specifics, required: ${d.aspects?.filter((a) => a.required).map((a) => a.name).join(", ")}`);

  const answers = Object.fromEntries((d.review?.questions ?? []).map((q) => [q.id, "Not sure"]));
  d = await call(`/drafts/${d.id}/facts`, { condition: "used", works: "Yes: Bluetooth pairing and noise cancelling tested", marks: "None that I can see", included: "Headphones only", answers });
  check("facts saved", d.facts?.condition === "used");

  d = await job(`/drafts/${d.id}/compose`);
  check("Claude wrote the listing", Boolean(d.listing?.title), `"${d.listing?.title}" (${d.listing?.title?.length} chars), ${d.listing?.specifics?.length} specifics kept, ${d.listing?.dropped?.length} left out`);
  for (const a of (d.aspects ?? []).filter((a) => a.required && !d.listing.specifics.some((s) => s.name === a.name))) {
    const value = a.name === "Brand" ? "Sony" : a.name === "Model" ? "WH-1000XM4" : a.values[0] ?? "Unbranded";
    d = await call(`/drafts/${d.id}/listing`, { addSpecific: { name: a.name, value } });
    console.log(`      added required specific ${a.name}: ${value}`);
  }

  d = await job(`/drafts/${d.id}/price-check`);
  check("the pricing engine priced it", Boolean(d.pricing), `${d.pricing?.strategy}: ${d.pricing?.price ?? d.pricing?.question}`);
  const price = d.pricing?.price ?? 25;
  d = await call(`/drafts/${d.id}/price`, { value: price, floor: null, bestOffer: true });
  check("price chosen", d.price?.value === price, `£${price} (${d.price?.kind})`);

  d = await call(`/drafts/${d.id}/quotes`, { lengthCm: 25, widthCm: 20, heightCm: 10, weightKg: 0.8 });
  console.log(`INFO  postage quotes: ${d.quotes?.error ?? `${d.quotes?.quotes?.length} quotes, cheapest ${d.quotes?.quotes?.[0]?.carrier} £${d.quotes?.quotes?.[0]?.price}`}`);
  d = await call(`/drafts/${d.id}/postage`, { cost: 4.5, collectionOffered: true, postcode: "SW1A 1AA", parcel: { lengthCm: 25, widthCm: 20, heightCm: 10, weightKg: 0.8 } });
  check("postage saved, nothing missing", d.missing.length === 0, d.missing.join("; "));

  const sent = await call(`/drafts/${d.id}/submit`, {});
  check("eBay's check passed and the label was filed", sent.status === "submitted" && Boolean(sent.proposal_id), sent.note);
  const label = (await call("/proposals")).find((p) => p.id === sent.proposal_id);
  check("the label is in the Inbox", label?.kind === "create_listing", `£${label?.payload?.price}, fees £${label?.payload?.verifiedFees}`);

  if (approve) {
    const out = await call("/proposals/decide", { ids: [sent.proposal_id], decision: "approve" });
    const result = out.results?.[0]?.result ?? JSON.stringify(out);
    check("approved: photos uploaded to eBay and the item listed", /AddFixedPriceItem ok/.test(result), result);
    const after = await call(`/drafts/${d.id}`);
    check("the draft says listed", after.status === "published", `item ${after.item_id}: https://sandbox.ebay.co.uk/itm/${after.item_id}`);
    const log = await call("/activity");
    const mine = log.filter((a) => a.proposal_id === sent.proposal_id).map((a) => `${a.call}:${a.outcome}`);
    check("every eBay write is in the audit log", mine.some((x) => x.startsWith("UploadSiteHostedPictures:applied")) && mine.includes("AddFixedPriceItem:applied"), mine.join(", "));
  } else console.log(`\nThe label is waiting in the Sandbox Inbox (draft ${d.id}). Run with --approve to publish it to eBay Sandbox.`);
} catch (e) {
  check("no step failed", false, e.message);
}
console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
