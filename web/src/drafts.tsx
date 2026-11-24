import { useState } from "preact/hooks";
import { api, SignedOut, type Proposal } from "./api";
import { money } from "./format";

// K's edits to drafts before approving: the reply to a buyer, or the answer to a Best Offer.

export const EDITABLE = ["message", "new_message", "best_offer_response"];

const isText = (p: Proposal) => p.kind === "message" || p.kind === "new_message";

export function DraftEditor({ p, onSaved, onSignedOut }: { p: Proposal; onSaved: () => void; onSignedOut: () => void }) {
  const a = p.payload ?? {};
  const [editing, setEditing] = useState(isText(p) && !a.body);
  const [body, setBody] = useState<string>(a.body ?? "");
  const [action, setAction] = useState<string>(a.action ?? "counter");
  const [counter, setCounter] = useState<string>(a.counterPrice != null ? String(a.counterPrice) : "");
  const [message, setMessage] = useState<string>(a.message ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const changes = isText(p) ? { body } : { action, counterPrice: Number(counter), message };
      await api(`/proposals/${p.id}/edit`, { body: changes });
      setEditing(false);
      onSaved();
    } catch (err) {
      if (err instanceof SignedOut) onSignedOut();
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (isText(p))
    return (
      <div class="draft">
        {p.kind === "new_message" ? (
          <p class="meta">To {a.recipientId || "a buyer"}</p>
        ) : (
          <blockquote class="quote">
            <span class="muted small" style={{ display: "block" }}>{a.recipientId} asked</span>
            {a.question}
          </blockquote>
        )}
        {editing ? (
          <form class="form" onSubmit={save}>
            <label for={`reply-${p.id}`}>Your reply</label>
            <textarea id={`reply-${p.id}`} rows={4} maxLength={2000} value={body} onInput={(e) => setBody(e.currentTarget.value)} required />
            {error && <p class="error">{error}</p>}
            <div class="actions">
              <button class="btn btn-quiet" disabled={busy || !body.trim()}>
                {busy ? "Saving" : "Save reply"}
              </button>
              {a.body && (
                <button type="button" class="btn btn-text" onClick={() => (setBody(a.body), setEditing(false))}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        ) : (
          <div class="reply">
            <span class="muted small">{a.editedByK ? "Your reply" : "Draft reply"}</span>
            <p>{a.body}</p>
            <button class="btn-link" onClick={() => setEditing(true)}>
              Edit reply
            </button>
          </div>
        )}
      </div>
    );

  const what = a.action === "accept" ? "Accept" : a.action === "decline" ? "Decline" : `Counter at ${money(a.counterPrice)}`;
  return (
    <div class="draft">
      <p class="meta">
        {money(a.offerPrice)} offered by {a.buyer}, asking {money(a.listPrice)}
        {a.fullPrice ? " (full asking price)" : a.listPrice ? ` (${Math.round(((a.listPrice - a.offerPrice) / a.listPrice) * 100)}% below)` : ""}.
      </p>
      {a.expiresAt && <p class="meta">{a.expiresAt > Date.now() ? `Answer by ${new Date(a.expiresAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}.` : "This offer has expired."}</p>}
      {a.floor != null && ((a.action === "accept" && a.offerPrice < a.floor) || (a.action === "counter" && a.counterPrice < a.floor)) && <p class="error">Below your floor of {money(a.floor)}.</p>}
      {a.buyerMessage && <blockquote class="quote">{a.buyerMessage}</blockquote>}
      {editing ? (
        <form class="form" onSubmit={save}>
          <fieldset class="choices">
            <legend>Your answer</legend>
            {["accept", "counter", "decline"].map((x) => (
              <label key={x} class="choice">
                <input type="radio" name={`action-${p.id}`} value={x} checked={action === x} onChange={() => setAction(x)} />
                {x === "accept" ? `Accept ${money(a.offerPrice)}` : x === "counter" ? "Counter" : "Decline"}
              </label>
            ))}
          </fieldset>
          {action === "counter" && (
            <>
              <label for={`counter-${p.id}`}>Counter price (£)</label>
              <input id={`counter-${p.id}`} type="number" inputMode="decimal" min="0.01" step="0.01" value={counter} onInput={(e) => setCounter(e.currentTarget.value)} required />
            </>
          )}
          <label for={`msg-${p.id}`}>Message to the buyer (optional)</label>
          <input id={`msg-${p.id}`} type="text" maxLength={250} value={message} onInput={(e) => setMessage(e.currentTarget.value)} />
          {error && <p class="error">{error}</p>}
          <div class="actions">
            <button class="btn btn-quiet" disabled={busy}>
              {busy ? "Saving" : "Save answer"}
            </button>
            <button type="button" class="btn btn-text" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div class="reply">
          <span class="muted small">{a.editedByK ? "Your answer" : "Suggested"}</span>
          <p>
            {what}
            {a.message ? `, with "${a.message}"` : ""}
          </p>
          <button class="btn-link" onClick={() => setEditing(true)}>
            Change answer
          </button>
        </div>
      )}
    </div>
  );
}
