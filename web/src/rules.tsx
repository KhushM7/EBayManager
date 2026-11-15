import { useEffect, useState } from "preact/hooks";
import { api, SignedOut } from "./api";
import { ago } from "./format";
import { Icons } from "./ui";

// K's standing rules for how Claude writes listings (src/guidance.ts): a suggestion box. The owner says what a
// description should do differently next time; Claude turns that into a rule to confirm; every later listing
// follows it. Owner only: the server refuses anyone else, and these pieces are only drawn for the owner.

export interface ListingRule {
  id: string;
  kind: "wording" | "fact";
  text: string;
  at: number;
  by: string | null;
}

interface RuleDraft {
  ok: boolean;
  kind: "wording" | "fact";
  text: string;
  replaces: string | null;
  note: string;
}

const KIND = { wording: "How it's written", fact: "True of every item" } as const;

/** The box itself: feedback in, a rule to confirm out. `onSaved` gets the rules after a save. */
export function TeachClaude({ onSaved, onSignedOut, startOpen = false }: { onSaved?: (rules: ListingRule[]) => void; onSignedOut: () => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ good: boolean; text: string } | null>(null);

  const call = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setMsg(null);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setMsg({ good: false, text: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      setBusy(false);
    }
  };
  const turnIntoRule = async () => {
    const r = await call(() => api<{ draft: RuleDraft }>("/listing-rules/draft", { body: { feedback } }));
    if (!r) return;
    if (r.draft.ok) setDraft(r.draft);
    else setMsg({ good: false, text: r.draft.note });
  };
  const save = async () => {
    if (!draft) return;
    const r = await call(() => api<{ rules: ListingRule[] }>("/listing-rules", { body: draft }));
    if (!r) return;
    setDraft(null);
    setFeedback("");
    setMsg({ good: true, text: "Saved. Claude follows it for every listing from now on." });
    onSaved?.(r.rules);
  };

  if (!open)
    return (
      <button class="btn-link inline-flex w-fit items-center gap-1 text-sm" onClick={() => setOpen(true)}>
        <Icons.sparkles size={14} /> Teach Claude how to write these
      </button>
    );
  return (
    <div class="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div>
        <p class="font-semibold">Teach Claude</p>
        <p class="text-sm text-muted">Say what it should do differently next time. It becomes a rule for every listing, not just this one.</p>
      </div>
      {!draft ? (
        <>
          <textarea rows={3} value={feedback} maxLength={600} placeholder="For example: put what's included before the specifications." onInput={(e) => setFeedback(e.currentTarget.value)} aria-label="What Claude should do differently" />
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-primary" disabled={busy || feedback.trim().length < 4} onClick={turnIntoRule}>
              {busy ? "Working…" : "Turn into a rule"}
            </button>
            {!startOpen && (
              <button class="btn btn-secondary" disabled={busy} onClick={() => (setOpen(false), setMsg(null))}>
                Close
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <label class="grid gap-1 text-sm">
            <span class="font-semibold">The rule, as Claude will follow it</span>
            <textarea rows={3} value={draft.text} maxLength={300} onInput={(e) => setDraft({ ...draft, text: e.currentTarget.value })} />
          </label>
          <p class="text-sm text-muted">
            {KIND[draft.kind]}.{draft.kind === "fact" ? " Claude will state it as your own fact about every item, so only keep it if that's true." : ""}
            {draft.replaces ? ` ${draft.note || "Replaces an earlier rule."}` : ""}
          </p>
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-primary" disabled={busy || draft.text.trim().length < 4} onClick={save}>
              {busy ? "Saving…" : "Save rule"}
            </button>
            <button class="btn btn-secondary" disabled={busy} onClick={() => setDraft(null)}>
              Back
            </button>
          </div>
        </>
      )}
      {msg && <p class={msg.good ? "result" : "error"}>{msg.text}</p>}
    </div>
  );
}

/** Settings → Listing style: the rules, with remove, and the box to add one. */
export function ListingRulesCard({ onSignedOut }: { onSignedOut: () => void }) {
  const [rules, setRules] = useState<ListingRule[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ rules: ListingRule[] }>("/listing-rules")
      .then((r) => setRules(r.rules))
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setError(e.message)));
  }, []);
  const remove = (id: string) =>
    api<{ rules: ListingRule[] }>(`/listing-rules/${id}`, { method: "DELETE" })
      .then((r) => setRules(r.rules))
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setError(e.message)));
  return (
    <div class="card grid gap-4">
      <div>
        <h2 class="m-0 text-lg font-semibold">How Claude writes your listings</h2>
        <p class="mt-1 text-sm text-muted">Your standing rules for titles and descriptions. They apply to every new listing and to Claude's rewrites of existing ones. Facts about an item still come only from its photos, what you say about it, and published specifications.</p>
      </div>
      {error && <p class="error">{error}</p>}
      {rules === undefined ? (
        <div class="skeleton h-16 w-full" />
      ) : rules.length === 0 ? (
        <p class="text-sm text-muted">No rules yet. Add one below, or from the listing step when a description isn't how you'd write it.</p>
      ) : (
        <ul class="m-0 grid list-none gap-2 p-0">
          {rules.map((r) => (
            <li key={r.id} class="flex items-start gap-3 rounded-2xl border border-line bg-surface p-3">
              <span class="min-w-0 flex-1">
                <span class="block">{r.text}</span>
                <span class="block text-xs text-muted">
                  {KIND[r.kind]} · added {ago(r.at)}
                  {r.by ? ` by ${r.by}` : ""}
                </span>
              </span>
              <button class="btn-link flex-none text-sm" onClick={() => remove(r.id)} aria-label={`Remove rule: ${r.text}`}>
                <Icons.trash size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <TeachClaude startOpen onSignedOut={onSignedOut} onSaved={setRules} />
    </div>
  );
}
