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
- Inbox to-dos (below).

## To-dos (2026-11-05, K's choice)

The Inbox holds two things: **labels** (proposals, which change eBay only once approved) and **to-dos**, which never change eBay. A to-do is what only a person can do, filed by the first-day audit and the nightly run (`src/todos.ts`, stored in the `pricing` container under its own partition). Each leads with what to do and names the listing:

| Kind | Example | Action | Who |
| --- | --- | --- | --- |
| Answer | The pricing engine's question, missing measurements, a fault to describe | The answer is saved as K's facts for the listing (the engine and Claude's edits use them, cited "from K"); an engine question also starts a fresh price check | K only |
| Claude can do this | "Let Claude improve this listing" (title, specifics, description) | Runs the Claude listing review, which files ordinary labels | Anyone |
| For you to do | Add photos, turn on Best Offer, a flagged listing that got no label | Done or Dismiss | Anyone |

A finding that already has a label gets no to-do. One to-do per check and listing (or policy): the audit and the nightly file the same one, not two. A rerun refreshes open to-dos and resolves those whose problem has gone; a dismissed or done to-do stays closed unless the problem changes (its fingerprint), and to-dos for ended listings close. The Inbox badge counts labels plus open to-dos.

## Proposal lifecycle

```
          ┌──────────► rejected
pending ──┤
          ├──────────► expired      (after 7 days, or when superseded)
          └─► approved ─► applied
                       └► failed     (eBay error; shown in Inbox with a retry proposal)
```

- One pending price, revision or ad-rate proposal per item: a newer one supersedes the older, which becomes `expired`. Replies and offer responses never supersede each other, since each answers a different buyer.
- A draft that can't become an eBay call yet (an empty reply, a kind not built) stays `pending` when K taps Approve, with the reason, so K can finish it.
- K can edit pending replies and offer answers in the Inbox before approving.
- An approved proposal is applied immediately by the write gate. If the gate refuses it because writes are paused, it stays `approved` and is applied when K resumes writes. In production read-only it is marked dry run and never applied.
- Each proposal stores the old value, the new value, the reason, and any guardrail flags (for example "more than 10% change" or "below floor").

## How K approves

| Channel | How | Auth |
| --- | --- | --- |
| Push notification (main) | **Approve** and **Reject** buttons on the Android notification. The PWA's service worker POSTs the signed decision without opening the app | HMAC-signed link with 7-day expiry |
| Dashboard Inbox | Approve or reject one at a time, or tick several and approve as a batch. Shows a diff of old vs new | K's dashboard session plus a CSRF header |
| ntfy (fallback) | Tapping opens the signed `/decide/:id` confirmation page, and the button there POSTs | HMAC-signed link with 7-day expiry |

Rules that stay from Phase 0:

- Deciding needs a POST. A GET only shows the confirmation page, so link previews and prefetchers cannot approve.
- The signature covers the proposal id, the decision and, from Phase 1, the expiry time. The signing key is a Worker secret that Claude's tools never see.
- No tool, MCP or otherwise, can apply a proposal. Only `/decide/:id` and the dashboard API can.

Batch approval in the Inbox calls the same decide path once per proposal. Each is applied and logged on its own, so one failure doesn't block the rest.

## Auto-apply (Phase 9, opt-in, owner only)

At launch nothing is auto-applied: every change waits for a tap. Later, K can switch on these in Settings, each separately:

| Switch | What applies without a tap |
| --- | --- |
| Title changes | New titles from reviews and the nightly check |
| Description changes | New descriptions |
| Item specifics | Added or corrected item specifics |

Each auto-applied change:
- still goes through the write gate and the eBay call allowlist;
- is written to the Activity log, attributed to "auto-apply";
- sends a **"Done"** notification saying exactly what changed (old and new), with a one-tap proposal to undo it.

The pause switch stops auto-apply too. Prices, offers, counters, buyer replies, new listings, ending listings, promotion and policies are `LOCKED_KINDS`: always approval, refused by the gate even if a setting claims otherwise.
