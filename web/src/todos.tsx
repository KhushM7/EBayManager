import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { ago } from "./format";

// Inbox to-dos (src/todos.ts): what needs one of you but isn't an eBay change. Each leads with what to do.
// Answers are saved as K's facts; "Let Claude draft" runs the listing review, whose changes come back as
// ordinary labels below. Nothing here changes eBay.

export interface Todo {
  id: string;
  code: string;
  kind: "answer" | "claude" | "you";
  source: string;
  item_id: string | null;
  item_title: string | null;
  title: string;
  detail: string;
  question: string | null;
  status: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
}

const KIND: Record<Todo["kind"], [string, string]> = {
  answer: ["state-decide", "Needs your answer"],
  claude: ["state-info", "Claude can do this"],
  you: ["state-held", "For you to do"],
};

function Detail({ text }: { text: string }) {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length < 2) return text ? <p>{text}</p> : null;
  return (
    <ul class="todo-points">
      {lines.map((l) => (
        <li>{l}</li>
      ))}
    </ul>
  );
}

function TodoLabel({ t, i, owner, onDone, onSignedOut }: { t: Todo; i: number; owner: boolean; onDone: () => void; onSignedOut: () => void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cls, word] = KIND[t.kind];

  const act = async (action: "done" | "dismiss" | "answer" | "claude", body: object = {}) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ note?: string }>(`/todos/${t.id}/${action}`, { body });
      setResult(r.note ?? (action === "dismiss" ? "Dismissed." : "Done."));
      setTimeout(onDone, 1400);
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canAnswer = t.kind === "answer" && owner;
  return (
    <li class="label paper" style={{ "--i": Math.min(i, 10) }}>
      <div class="label-body">
        <p class={`state ${cls}`}>{word}</p>
        <h3 class="kind todo-title">{t.title}</h3>
        {t.item_title && <p class="item-title">{t.item_title}</p>}
        {t.question && <p class="quote">{t.question}</p>}
        <Detail text={t.detail} />
        {canAnswer && !result && (
          <div class="form">
            <label>
              Your answer
              <textarea rows={2} value={answer} onInput={(e) => setAnswer((e.target as HTMLTextAreaElement).value)} />
            </label>
          </div>
        )}
        {t.kind === "answer" && !owner && <p class="small muted">K answers this: answers are saved as K's facts about the item.</p>}
        {error && <p class="error">{error}</p>}
        <p class="small muted">
          {t.source === "nightly" ? "From the nightly check" : "From the audit"}, {ago(t.created_at)}
          {t.item_id ? ` · item ${t.item_id}` : ""}
        </p>
      </div>
      <div class="label-stub">
        {result ? (
          <p class="result" role="status">
            {result}
          </p>
        ) : (
          <>
            {canAnswer && (
              <button class="btn btn-stamp" disabled={busy || !answer.trim()} onClick={() => act("answer", { text: answer })}>
                Save answer
              </button>
            )}
            {t.kind === "claude" && (
              <>
                <button class="btn btn-stamp" disabled={busy} onClick={() => act("claude")}>
                  {busy ? "Starting" : "Let Claude draft"}
                </button>
                <p class="small">About 5 to 10 cents. You approve each change.</p>
              </>
            )}
            {t.kind === "you" && (
              <button class="btn btn-stamp" disabled={busy} onClick={() => act("done")}>
                Done
              </button>
            )}
            <button class="btn btn-text" disabled={busy} onClick={() => act("dismiss")}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** The open to-dos, above the labels. Reports how many there are, for the Inbox heading and the badge. */
export function Todos({ me, onSignedOut, onCount, onChanged }: { me: Me; onSignedOut: () => void; onCount: (n: number) => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Todo[] | null>(null);
  const load = () =>
    api<Todo[]>("/todos")
      .then((r) => (setRows(r), onCount(r.length)))
      .catch((e) => e instanceof SignedOut && onSignedOut());
  useEffect(() => {
    load();
  }, []);
  if (!rows?.length) return null;
  return (
    <section class="section" aria-label="To do">
      <h2>To do</h2>
      <ol class="labels">
        {rows.map((t, i) => (
          <TodoLabel key={t.id} t={t} i={i} owner={me.user.role === "owner"} onDone={() => (load(), onChanged())} onSignedOut={onSignedOut} />
        ))}
      </ol>
    </section>
  );
}
