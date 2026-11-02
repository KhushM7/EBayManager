# Approvals

Every change to the eBay account needs K's approval. That includes titles, item specifics, ad rates, ending listings and business policies, as well as prices and messages. Claude and the nightly jobs can only create **proposals**. A proposal changes eBay only after K approves it, and only through the [write gate](safety-and-environments.md#the-write-gate).

Decided 2026-11-02, replacing the earlier rule that covered only prices and messages. K may later opt some low-risk kinds into auto-apply. Locked kinds can never be auto-applied.

## What needs approval

| Kind | What it changes | eBay call | Auto-apply later? |
| --- | --- | --- | --- |
| `price` | Price of a listing | Trading `ReviseFixedPriceItem` | **Locked** |
| `message` | A message to a buyer | Trading `AddMemberMessageRTQ` | **Locked** |
| `best_offer_response` | Accept, decline or counter a Best Offer | Trading `RespondToBestOffer` | **Locked** |
| `offer_to_watchers` | Send a discount offer to watchers | Negotiation `sendOfferToInterestedBuyers` | **Locked** |
| `create_listing` | Publish a new listing | Trading `AddFixedPriceItem` (Inventory `publishOffer` from Phase 8) | **Locked** |
| `end_listing` | End a listing early | Trading `EndFixedPriceItem` | **Locked** |
| `policy` | Return, shipping or payment business policy | Account API | **Locked** |
| `revise` | Title, item specifics, description, photos, condition text | Trading `ReviseFixedPriceItem` | Eligible |
| `promote` | Promoted Listings ad rate | Marketing API | Eligible |
| `relist` | Relist an ended, unsold item with no changes | Trading `RelistFixedPriceItem` | Eligible |

The locked list is a constant in `src/rules.ts` (`LOCKED_KINDS`). The dashboard reads it and cannot change it. Changing it needs a code change and a deploy.

## What does not need approval

These never change anything on eBay:

- Reading listings, orders, messages, traffic and comps.
- Nightly snapshots (`listing_snapshots`).
- K's own settings stored in D1: floor price, collection only, notes, auto-apply toggles.
- Claude analysis, drafts and proposals. Creating a proposal changes nothing.

## Proposal lifecycle

```
          ┌──────────► rejected
pending ──┤
          ├──────────► expired      (after 7 days, or when superseded)
          └─► approved ─► applied
                       └► failed     (eBay error; shown in Inbox with a retry proposal)
```

- One pending proposal per item and field. A newer proposal for the same item and field supersedes the older one, which becomes `expired`.
- An approved proposal is applied immediately by the write gate. If the gate refuses it, for example because writes are paused or the stage is read-only, it stays `approved` and is applied when the gate opens. In production read-only it is marked dry run and never applied.
- Each proposal stores the old value, the new value, the reason, and any guardrail flags (for example "more than 10% change" or "below floor").

## How K approves

| Channel | How | Auth |
| --- | --- | --- |
| Push notification (main) | **Approve** and **Reject** buttons on the Android notification. The PWA's service worker POSTs the signed decision without opening the app | HMAC-signed link with 7-day expiry |
| Dashboard Inbox | Approve or reject one at a time, or tick several and approve as a batch. Shows a diff of old vs new | Cloudflare Access session plus a CSRF token |
| ntfy (fallback) | Tapping opens the signed `/decide/:id` confirmation page, and the button there POSTs | HMAC-signed link with 7-day expiry |

Rules that stay from Phase 0:

- Deciding needs a POST. A GET only shows the confirmation page, so link previews and prefetchers cannot approve.
- The signature covers the proposal id, the decision and, from Phase 1, the expiry time. The signing key is a Worker secret that Claude's tools never see.
- No tool, MCP or otherwise, can apply a proposal. Only `/decide/:id` and the dashboard API can.

Batch approval in the Inbox calls the same decide path once per proposal. Each is applied and logged on its own, so one failure doesn't block the rest.

## Auto-apply (later, opt-in)

Not built at launch. When it is:

- A D1 `auto_apply` table holds one row per eligible kind that K has switched on in Settings. It is empty by default.
- An auto-applied proposal still goes through the write gate, is written to the audit log and sends a "Done:" push so K sees it.
- The kill switch stops auto-apply too.
- Locked kinds are refused by the gate even if a row exists for them.
