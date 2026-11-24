import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { money, plural } from "./format";
import { preview, showable } from "./quoted";
import { Icons, Toasts, useFocusFlow, useToasts } from "./ui";

// Messages (src/offersapi.ts): choose a buyer, read the whole chat with the latest at the bottom, reply. Side by side
// on a desktop; on a phone the chat fills the screen. A message becomes a label and is approved by the same tap; only
// the write gate sends it. Text is shown as text: nothing in a buyer's message becomes a link or loads anything.

interface Conversation {
  id: string;
  otherParty: string;
  itemId: string | null;
  itemTitle: string | null;
  itemPrice: number | null;
  image: string | null;
  lastText: string;
  lastMine: boolean;
  lastAt: number | null;
  unread: number;
}

interface Message {
  id: string;
  side: "me" | "buyer" | "unknown";
  text: string;
  at: number | null;
}

interface Send {
  id: string;
  body: string;
  status: string;
  result: string | null;
  at: number;
}

interface Chat {
  messages: Message[];
  sends: Send[];
  /** The offset of the next older page, or null at the start of the chat. */
  older: number | null;
}

interface Person {
  buyer: string;
  item_id: string;
  item_title?: string | null;
}

interface Props {
  me: Me;
  onSignedOut: () => void;
  onChanged: () => void;
  go: (to: string) => void;
}

const DAY = 86_400_000;
const GROUP = 5 * 60_000;
const midnight = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(new Date(ms).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) });
const daysAgo = (ms: number) => Math.round((midnight(Date.now()) - midnight(ms)) / DAY);
const listTime = (ms: number) => (daysAgo(ms) <= 0 ? clock(ms) : daysAgo(ms) === 1 ? "Yesterday" : shortDate(ms));
const dayLabel = (ms: number) => (daysAgo(ms) <= 0 ? "Today" : daysAgo(ms) === 1 ? "Yesterday" : `${new Date(ms).toLocaleDateString("en-GB", { weekday: "short" })} ${shortDate(ms)}`);

const stored = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k) ?? "";
    } catch {
      return "";
    }
  },
  set: (k: string, v: string) => {
    try {
      if (v) sessionStorage.setItem(k, v);
      else sessionStorage.removeItem(k);
    } catch {
      // Private browsing: the draft just isn't kept.
    }
  },
};

async function approve(id: string): Promise<string> {
  const { results } = await api<{ results: { id: string; result: string }[] }>("/proposals/decide", { body: { ids: [id], decision: "approve" } });
  return results[0]?.result ?? "Nothing was decided";
}

function Picture({ src }: { src: string | null }) {
  const [bad, setBad] = useState(false);
  return <span class="msg-pic">{src && !bad ? <img src={src} alt="" loading="lazy" onError={() => setBad(true)} /> : <Icons.box size={20} />}</span>;
}

function Bubble({ side, at, text, who, last, state, children }: { side: Message["side"]; at: number | null; text: string; who: string; last: boolean; state?: string; children?: ComponentChildren }) {
  const [quote, setQuote] = useState(false);
  const [all, setAll] = useState(false);
  const { body, quoted } = showable(text);
  const long = body.length > 1200;
  return (
    <li class={`msg ${side === "me" ? "msg-me" : "msg-them"} ${last ? "msg-last" : ""} ${state ? "msg-unsent" : ""}`}>
      <div class="msg-bubble">
        <span class="sr-only">
          {side === "me" ? "You" : side === "buyer" ? who : "Sender not known"}
          {at ? `, ${clock(at)}` : ""}:
        </span>
        <p>{long && !all ? `${body.slice(0, 1000)}…` : body}</p>
        {long && !all && (
          <button class="btn-link" onClick={() => setAll(true)}>
            Show more
          </button>
        )}
        {quoted && (
          <button class="btn-link" aria-expanded={quote} onClick={() => setQuote(!quote)}>
            {quote ? "Hide quoted text" : "Show quoted text"}
          </button>
        )}
        {quoted && quote && <p class="msg-quoted">{quoted}</p>}
        <span class="msg-meta">
          {side === "unknown" && "Sender not known "}
          {state && <strong>{state} </strong>}
          {at && <time dateTime={new Date(at).toISOString()}>{clock(at)}</time>}
        </span>
        {children}
      </div>
    </li>
  );
}

/** The words for one of the person's own messages that eBay hasn't shown back yet; null when it needs none. */
function sendState(s: Send): string | null {
  if (s.status === "pending") return "Waiting for approval";
  if (s.status === "applying") return "Sending";
  if (s.status === "approved") return "Approved, not sent yet";
  if (s.status === "applied") return "Sent";
  if (s.status === "failed") return /timeout|network|fetch failed|aborted/i.test(s.result ?? "") ? "May have been sent: check eBay first" : "Not sent";
  if (s.status === "agreed") return "Dry run, not sent";
  return null;
}

function Thread({ me, c, onBack, onSignedOut, onSent }: { me: Me; c: Conversation; onBack: () => void; onSignedOut: () => void; onSent: () => void }) {
  useFocusFlow();
  const key = `msg:${me.user.id}:${c.id}`;
  const [chat, setChat] = useState<Chat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(() => stored.get(key));
  const [busy, setBusy] = useState(false);
  const [below, setBelow] = useState(false);
  const toasts = useToasts();
  const alive = useRef(true);
  const root = useRef<HTMLElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pinned = useRef(true);
  const keep = useRef<number | null>(null);

  const fail = (e: unknown) => {
    if (!alive.current) return;
    if (e instanceof SignedOut) onSignedOut();
    else setError((e as Error).message);
  };
  /** The newest page, with any older pages already shown kept above it. */
  const load = () =>
    api<Chat>(`/conversations/${encodeURIComponent(c.id)}`)
      .then((r) => {
        if (!alive.current) return;
        setError(null);
        setChat((was) => {
          if (!was) return r;
          const fresh = new Set(r.messages.map((m) => m.id));
          return { ...r, messages: [...was.messages.filter((m) => !fresh.has(m.id)), ...r.messages].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), older: was.older };
        });
      })
      .catch(fail);
  const loadOlder = () => {
    if (chat?.older == null) return;
    api<Chat>(`/conversations/${encodeURIComponent(c.id)}/${chat.older}`)
      .then((r) => {
        if (!alive.current) return;
        keep.current = (log.current?.scrollHeight ?? 0) - (log.current?.scrollTop ?? 0);
        setChat((was) => {
          if (!was) return r;
          const have = new Set(was.messages.map((m) => m.id));
          return { ...was, messages: [...r.messages.filter((m) => !have.has(m.id)), ...was.messages], older: r.older };
        });
      })
      .catch(fail);
  };

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    if (matchMedia("(max-width: 860px)").matches) {
      heading.current?.focus({ preventScroll: true });
      document.body.classList.add("msg-open");
    }
    return () => {
      alive.current = false;
      clearInterval(t);
      document.body.classList.remove("msg-open");
    };
  }, []);

  // The phone's keyboard shrinks only the visible part of the page: the chat follows that, so the reply box stays above it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => {
      root.current?.style.setProperty("--vvh", `${vv.height}px`);
      root.current?.style.setProperty("--vvt", `${vv.offsetTop}px`);
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => (vv.removeEventListener("resize", fit), vv.removeEventListener("scroll", fit));
  }, []);

  // At the newest message before the first paint, and kept there while the reader hasn't scrolled up.
  useLayoutEffect(() => {
    const el = log.current;
    if (!el || !chat) return;
    if (keep.current != null) {
      el.scrollTop = el.scrollHeight - keep.current;
      keep.current = null;
    } else if (pinned.current) el.scrollTop = el.scrollHeight;
    else setBelow(true);
  }, [chat]);
  useEffect(() => {
    if (!inner.current || !log.current) return;
    const ro = new ResizeObserver(() => pinned.current && log.current && (log.current.scrollTop = log.current.scrollHeight));
    ro.observe(inner.current);
    ro.observe(log.current);
    return () => ro.disconnect();
  }, [chat === null]);
  const onScroll = () => {
    const el = log.current!;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (pinned.current) setBelow(false);
  };
  const toBottom = () => {
    pinned.current = true;
    setBelow(false);
    log.current?.scrollTo({ top: log.current.scrollHeight });
  };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 140)}px`;
  }, [text]);
  const write = (v: string) => (setText(v), stored.set(key, v));

  const send = async (body: string) => {
    if (busy || !body.trim()) return;
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("/conversations/message", { body: { conversationId: c.id, recipientId: c.otherParty, itemId: c.itemId, body } });
      if (body === text) write("");
      pinned.current = true;
      const result = await approve(id);
      if (!/ok$/.test(result)) toasts.push("bad", result);
      onSent();
    } catch (e) {
      if (e instanceof SignedOut) onSignedOut();
      else toasts.push("bad", (e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };
  const decideSend = async (id: string, decision: "approve" | "reject") => {
    try {
      await api("/proposals/decide", { body: { ids: [id], decision } });
    } catch (e) {
      fail(e);
    }
    load();
    onSent();
  };

  const name = c.otherParty || "A buyer";
  // Once eBay shows a sent message back, its own bubble replaces the label's.
  const sends = (chat?.sends ?? []).filter((s) => sendState(s) && !(s.status === "applied" && (Date.now() - s.at > DAY || chat!.messages.some((m) => m.side === "me" && m.text.trim() === s.body.trim() && (m.at ?? 0) > s.at - 5 * 60_000))));
  const rows = chat?.messages ?? [];

  return (
    <section class="msg-thread" ref={root} aria-label={`Chat with ${name}`}>
      <header class="msg-head">
        <button class="msg-back" onClick={onBack} aria-label="Back to all messages">
          <span aria-hidden="true">‹</span>
        </button>
        <Picture src={c.image} />
        <div class="min-w-0 flex-1">
          <h2 ref={heading} tabIndex={-1}>
            {name}
          </h2>
          <p>{c.itemId ? `${c.itemTitle ?? `Listing ${c.itemId}`}${c.itemPrice != null ? ` · Listed at ${money(c.itemPrice)}` : ""}` : "No listing linked"}</p>
        </div>
      </header>

      <div class="msg-log" ref={log} onScroll={onScroll} role="log" aria-live={chat ? "polite" : "off"} aria-label="Messages" tabIndex={0}>
        {error && (
          <p class="error p-4">
            {error}{" "}
            <button class="btn-link" onClick={load}>
              Try again
            </button>
          </p>
        )}
        {!chat && !error && (
          <div class="grid gap-3 p-4">
            <div class="skeleton h-12 w-2/3" />
            <div class="skeleton h-12 w-1/2 justify-self-end" />
            <div class="skeleton h-16 w-3/4" />
          </div>
        )}
        {chat && (
          <ol class="msg-list" ref={inner}>
            {chat.older != null && (
              <li class="msg-day">
                <button class="btn-link" onClick={loadOlder}>
                  Show earlier messages
                </button>
              </li>
            )}
            {!rows.length && !sends.length && <li class="msg-day">No messages yet</li>}
            {rows.map((m, i) => {
              const prev = rows[i - 1];
              const next = rows[i + 1];
              const newDay = m.at != null && (prev?.at == null || midnight(prev.at) !== midnight(m.at));
              const last = !next || next.side !== m.side || next.at == null || m.at == null || next.at - m.at > GROUP || midnight(next.at) !== midnight(m.at);
              return [
                newDay && (
                  <li class="msg-day" key={`d${m.id}`}>
                    {dayLabel(m.at!)}
                  </li>
                ),
                <Bubble key={m.id} side={m.side} at={m.at} text={m.text} who={name} last={last} />,
              ];
            })}
            {sends.map((s) => (
              <Bubble key={s.id} side="me" at={s.at} text={s.body} who={name} last state={sendState(s)!}>
                {s.status === "pending" && (
                  <span class="msg-actions">
                    <button class="btn-link" onClick={() => decideSend(s.id, "approve")}>
                      Approve and send
                    </button>
                    <button class="btn-link" onClick={() => decideSend(s.id, "reject")}>
                      Don't send
                    </button>
                  </span>
                )}
                {s.status === "failed" && (
                  <span class="msg-actions">
                    <button class="btn-link" disabled={busy} onClick={() => send(s.body)}>
                      Try again
                    </button>
                  </span>
                )}
              </Bubble>
            ))}
          </ol>
        )}
      </div>
      {below && (
        <button class="msg-pill" onClick={toBottom}>
          New messages
        </button>
      )}

      <form
        class="msg-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label class="sr-only" for="msg-text">
          Message to {name}
        </label>
        <textarea
          id="msg-text"
          ref={box}
          rows={1}
          maxLength={2000}
          placeholder="Message"
          value={text}
          onInput={(e) => write(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send(text);
            }
          }}
        />
        <button class="btn btn-primary" disabled={busy || !text.trim()} title="Approves the message and sends it on eBay">
          {busy ? "Sending" : "Send"}
        </button>
        {text.length >= 1800 && <span class="msg-count">{2000 - text.length} left</span>}
      </form>
      <Toasts items={toasts.items} />
    </section>
  );
}

/** A first message to someone who made an offer; eBay decides whether it's allowed. */
function NewMessage({ onDone, onCancel, onSignedOut }: { onDone: (msg: string, ok: boolean) => void; onCancel: () => void; onSignedOut: () => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ offers: Person[] }>("/offers")
      .then((r) => setPeople([...new Map(r.offers.filter((o) => o.buyer).map((o) => [o.buyer, o])).values()].slice(0, 20)))
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setPeople([])));
  }, []);
  const send = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("/conversations/message", { body: { recipientId: to, itemId: people?.find((p) => p.buyer === to)?.item_id, body } });
      const r = await approve(id);
      onDone(/ok$/.test(r) ? "Message sent." : r, /ok$/.test(r));
    } catch (err) {
      if (err instanceof SignedOut) onSignedOut();
      else onDone((err as Error).message, false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="form border-b border-line p-4" onSubmit={send}>
      <label for="msg-to">Write to</label>
      <select id="msg-to" value={to} onChange={(e) => setTo(e.currentTarget.value)} required>
        <option value="">{people && !people.length ? "Nobody has made an offer yet" : "Choose someone who made an offer"}</option>
        {(people ?? []).map((p) => (
          <option key={p.buyer} value={p.buyer}>
            {p.buyer}, about {p.item_title || p.item_id}
          </option>
        ))}
      </select>
      <label for="msg-first">Message</label>
      <textarea id="msg-first" rows={3} maxLength={2000} value={body} onInput={(e) => setBody(e.currentTarget.value)} required />
      <div class="actions">
        <button class="btn btn-primary" disabled={busy || !to || !body.trim()}>
          {busy ? "Sending" : "Approve and send"}
        </button>
        <button type="button" class="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const chosen = () => new URLSearchParams(location.search).get("c");

export function Messages({ me, onSignedOut, onChanged }: Props) {
  const [data, setData] = useState<{ canMessage: boolean; conversations: Conversation[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(chosen);
  const [writing, setWriting] = useState(false);
  // Opened here by a tap (so Back can undo it), rather than by a link straight to a chat.
  const pushed = useRef(false);
  const toasts = useToasts();

  const load = () =>
    api<{ canMessage: boolean; conversations: Conversation[] }>("/conversations")
      .then((r) => (setData(r), setError(null)))
      .catch((e) => (e instanceof SignedOut ? onSignedOut() : setError((e as Error).message)));
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    const back = () => setId(chosen());
    addEventListener("popstate", back);
    return () => (clearInterval(t), removeEventListener("popstate", back));
  }, []);

  const open = (next: string) => {
    const to = `/messages?c=${encodeURIComponent(next)}`;
    if (matchMedia("(max-width: 860px)").matches) {
      history.pushState(null, "", to);
      pushed.current = true;
    } else history.replaceState(null, "", to);
    setId(next);
  };
  const close = () => {
    if (pushed.current) {
      pushed.current = false;
      history.back();
      return;
    }
    history.replaceState(null, "", "/messages");
    setId(null);
  };

  const head = (
    <div class="page-head">
      <div>
        <h1>Messages</h1>
        <p>{data?.canMessage ? `${plural(data.conversations.length, "conversation")} on eBay.` : "Conversations with buyers."}</p>
      </div>
      {data?.canMessage && (
        <button class="btn btn-secondary" aria-expanded={writing} onClick={() => setWriting(!writing)}>
          <Icons.plus size={16} /> New message
        </button>
      )}
    </div>
  );
  if (data && !data.canMessage)
    return (
      <div class="max-w-3xl">
        {head}
        <div class="card">
          <p class="font-semibold">Writing to buyers needs one more eBay permission</p>
          <p class="mt-1 text-sm text-muted">eBay is still connected and everything else works. Signing in to eBay once more, and allowing messages, adds this. Buyers' questions about a listing already come to the Inbox, where you can reply.</p>
          {me.user.role === "owner" ? (
            <p class="mt-3">
              <a class="btn btn-primary" href="/oauth/start?messages=1">
                Allow messages
              </a>
            </p>
          ) : (
            <p class="mt-2 text-sm text-muted">Only the owner can do this.</p>
          )}
        </div>
      </div>
    );

  const c = data?.conversations.find((x) => x.id === id) ?? (data && id ? { id, otherParty: "", itemId: null, itemTitle: null, itemPrice: null, image: null, lastText: "", lastMine: false, lastAt: null, unread: 0 } : null);
  return (
    <div class="msg-page">
      {head}
      {error && <p class="error">{error}</p>}
      <div class="msg-panes">
        <div class="msg-side">
          {writing && (
            <NewMessage
              onSignedOut={onSignedOut}
              onCancel={() => setWriting(false)}
              onDone={(m, ok) => {
                toasts.push(ok ? "good" : "bad", m);
                if (ok) setWriting(false);
                load();
                onChanged();
              }}
            />
          )}
          {!data && !error && (
            <div class="grid gap-2 p-4">
              {[0, 1, 2, 3].map((n) => (
                <div class="skeleton h-14 w-full" key={n} />
              ))}
            </div>
          )}
          {data && !data.conversations.length && <p class="muted p-4">No messages yet.</p>}
          <ul>
            {data?.conversations.map((x) => (
              <li key={x.id}>
                <a
                  class="msg-row"
                  href={`/messages?c=${encodeURIComponent(x.id)}`}
                  aria-current={x.id === id ? "true" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    open(x.id);
                  }}
                >
                  <Picture src={x.image} />
                  <span class="min-w-0 flex-1">
                    <span class="flex items-baseline gap-2">
                      <span class="msg-name">{x.otherParty || "A buyer"}</span>
                      {x.lastAt && <time class="msg-when">{listTime(x.lastAt)}</time>}
                    </span>
                    {x.itemTitle && <span class="msg-item">{x.itemTitle}</span>}
                    <span class={`msg-preview ${x.unread ? "msg-unread" : ""}`}>
                      {x.lastMine ? "You: " : ""}
                      {preview(x.lastText)}
                    </span>
                  </span>
                  {x.unread > 0 && (
                    <span class="count" aria-label={`${x.unread} new`}>
                      {x.unread}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </div>
        {c ? (
          <Thread
            key={c.id}
            me={me}
            c={c}
            onBack={close}
            onSignedOut={onSignedOut}
            onSent={() => {
              load();
              onChanged();
            }}
          />
        ) : (
          <p class="msg-none">Choose a conversation</p>
        )}
      </div>
      <Toasts items={toasts.items} />
    </div>
  );
}
