import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { ago } from "./format";
import { EASE_OUT, Icons, item, list } from "./ui";

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

const KIND: Record<Todo["kind"], [string, string, (p: { size?: number }) => any]> = {
  answer: ["text-red bg-red-soft", "Needs your answer", Icons.message],
  claude: ["text-accent bg-accent-soft", "Claude can handle this", Icons.sparkles],
  you: ["text-yellow bg-yellow-soft", "For you to do", Icons.check],
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
  const [tone, word, Icon] = KIND[t.kind];
  return (
    <motion.li layout variants={item} exit={{ opacity: 0, x: 40, transition: { duration: 0.25 } }} class="card glow-hover list-none">
      <div class="flex items-start gap-3">
        <span class={`grid size-10 flex-none place-items-center rounded-xl ${tone}`}>
          <Icon size={18} />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-xs font-semibold text-muted">{word}</p>
          <h3 class="mt-0.5 text-[15px] leading-snug">{t.title}</h3>
          {t.item_title && <p class="mt-0.5 truncate text-sm text-muted">{t.item_title}</p>}
        </div>
      </div>
      <div class="mt-3 text-[15px] text-ink-2">
        {t.question && <p class="quote">{t.question}</p>}
        <Detail text={t.detail} />
      </div>
      {canAnswer && !result && (
        <label class="mt-3 grid gap-1.5 text-sm font-semibold text-ink-2">
          Your answer
          <textarea rows={2} value={answer} onInput={(e) => setAnswer((e.target as HTMLTextAreaElement).value)} />
        </label>
      )}
      {t.kind === "answer" && !owner && <p class="mt-2 text-sm text-muted">K answers this: answers are saved as K's facts about the item.</p>}
      {error && <p class="error mt-3">{error}</p>}
      <AnimatePresence mode="wait">
        {result ? (
          <motion.p key="r" class="result mt-4" role="status" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ease: EASE_OUT }}>
            {result}
          </motion.p>
        ) : (
          <motion.div key="a" class="mt-4 flex flex-wrap items-center gap-2" exit={{ opacity: 0 }}>
            {canAnswer && (
              <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={busy || !answer.trim()} onClick={() => act("answer", { text: answer })}>
                Save answer
              </motion.button>
            )}
            {t.kind === "claude" && (
              <motion.button whileTap={{ scale: 0.95 }} class="btn btn-primary" disabled={busy} onClick={() => act("claude")}>
                <Icons.sparkles size={16} /> {busy ? "Starting" : "Let Claude draft it"}
              </motion.button>
            )}
            {t.kind === "you" && (
              <motion.button whileTap={{ scale: 0.95 }} class="btn btn-approve" disabled={busy} onClick={() => act("done")}>
                <Icons.check size={16} /> Done
              </motion.button>
            )}
            <motion.button whileTap={{ scale: 0.95 }} class="btn btn-text" disabled={busy} onClick={() => act("dismiss")}>
              Dismiss
            </motion.button>
            <span class="ml-auto text-xs text-muted">
              {t.source === "nightly" ? "Nightly check" : "Store Pulse"} · {ago(t.created_at)}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
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
    <section aria-label="Suggestions">
      <h2 class="inbox-sub flex items-center gap-2">
        <Icons.sparkles size={18} class="text-accent" /> Your assistant suggests
      </h2>
      <motion.ol class="m-0 grid gap-3 p-0" variants={list} initial="hidden" animate="show">
        <AnimatePresence initial={false}>
          {rows.map((t, i) => (
            <TodoLabel key={t.id} t={t} i={i} owner={me.user.role === "owner"} onDone={() => (load(), onChanged())} onSignedOut={onSignedOut} />
          ))}
        </AnimatePresence>
      </motion.ol>
    </section>
  );
}
