import { hashId, seqId, type BatchOp, type Doc } from "./doc";

// Suggestion events: what happened to a label, a to-do or a piece of bundle advice, one document each, never
// changed or deleted (docs/approvals.md, "History"). They sit in the same partition as what they describe, so a
// change and its event are written in one batch or not at all. Labels' events carry ids and codes only, never
// text, so nothing a buyer wrote is copied here.

export type SuggestionSource = "proposal" | "todo" | "advice";

export type ReasonCode =
  | "person"
  | "lapsed"
  | "superseded"
  | "problem_gone"
  | "label_filed"
  | "listing_sold"
  | "listing_ended"
  | "replaced_by_run"
  | "nothing_to_do"
  | "privacy_deletion"
  | "unknown";

export type EventName =
  | "filed"
  | "refreshed"
  | "notified"
  | "seen"
  | "edited"
  | "approved"
  | "sending"
  | "applied"
  | "failed"
  | "rejected"
  | "agreed"
  | "expired"
  | "done"
  | "dismissed"
  | "resolved"
  | "replaced"
  | "reopened";

export interface SuggestionEvent {
  suggestion_id: string;
  source: SuggestionSource;
  episode: number;
  item_id: string | null;
  kind: string;
  at: number;
  event: EventName;
  actor: string | null;
  reason_code: ReasonCode | null;
  superseded_by: string | null;
  /** To-dos only: the words as they stood, for to-dos that can't hold a buyer's words. */
  snapshot: { title: string; detail: string; note: string | null; filed_at: number; item_title: string | null } | null;
}

export const EVENT = "suggestion_event";

export type NewEvent = Pick<SuggestionEvent, "suggestion_id" | "source" | "item_id" | "kind" | "at" | "event"> & Partial<SuggestionEvent>;

const doc = (id: string, pk: string, e: NewEvent): Doc => ({
  id,
  pk,
  type: EVENT,
  episode: 1,
  actor: null,
  reason_code: null,
  superseded_by: null,
  snapshot: null,
  ...e,
  // The proposals container indexes created_at, not at.
  created_at: e.at,
});

export const eventDoc = (pk: string, e: NewEvent): Doc => doc(`ev:${seqId(e.at)}`, pk, e);

/** For a batch: create only, so an event is never overwritten. */
export const eventOp = (pk: string, e: NewEvent): BatchOp => ({ op: "create", doc: eventDoc(pk, e) });

/** One "seen" per person, suggestion and episode: the id repeats, so a second create does nothing. */
export const seenDoc = async (pk: string, userId: string, e: NewEvent): Promise<Doc> =>
  doc(`ev:seen:${await hashId(`${e.source}:${e.suggestion_id}:${e.episode ?? 1}:${userId}`)}`, pk, { ...e, event: "seen" });
