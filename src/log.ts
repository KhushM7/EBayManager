import type { Env } from "./env";
import { redact } from "./redact";

// The app's log (docs/architecture.md, "Logs and monitoring"). One call writes one short JSON line for
// Azure's logs (through env.logSink, set by the platform layer) and one event in the store, which stays readable
// when Azure's daily cap is reached. It never throws, and takes named fields only: never pass a buyer's name,
// a message's text or an address. src/ro must not import this (it writes); it may import redact.ts.
//
// Azure's share is kept small (the workspaces are capped each day): lines are short, routine lines stop at an hourly
// allowance per instance and are counted instead, and the same warning or error again within ten minutes is
// counted, not repeated. Other warnings and errors always go. flushLog() reports the counts at the end of a run.

const DAY_S = 86_400;
const TTL_S = { info: 14 * DAY_S, warn: 90 * DAY_S, error: 90 * DAY_S } as const;

/** Azure: routine lines per instance and hour, in characters. */
export const INFO_CHARS_PER_HOUR = 150_000;
export const LINE_CHARS = 1500;
/** The store: events per run. Routine ones stop first, so a failure late in a long run still fits. */
export const MAX_INFO_EVENTS = 150;
export const MAX_EVENTS = 250;
const REPEAT_MS = 10 * 60_000;

export type Level = keyof typeof TTL_S;

export interface LogFields {
  job?: string;
  runId?: string;
  itemId?: string;
  proposalId?: string;
  ms?: number;
  /** Plain words or short JSON about what happened; redacted and cut to 1,000 characters. */
  detail?: string;
  err?: unknown;
  /** Azure line only, no stored event: routine lines that would only be noise. */
  lineOnly?: boolean;
}

export interface LogEvent {
  id: string;
  kind: string;
  status: Level;
  created_at: number;
  job: string | null;
  run_id: string | null;
  item_id: string | null;
  proposal_id: string | null;
  ms: number | null;
  detail: string | null;
}

interface Run {
  job?: string;
  runId?: string;
  stored: number;
  capped: boolean;
}
const runs = new WeakMap<object, Run>();
const runOf = (env: Env) => {
  let r = runs.get(env);
  if (!r) runs.set(env, (r = { stored: 0, capped: false }));
  return r;
};

/** Names the run this env belongs to (one env object per invocation), so every line and event carries it. */
export function startRun(env: Env, job: string, runId: string) {
  runs.set(env, { job, runId, stored: 0, capped: false });
}

// This instance's Azure allowance and the failures it has recently reported.
const sinkState = { hour: -1, chars: 0, dropped: 0, seen: new Map<string, { at: number; repeats: number }>() };

/** For tests. */
export function resetLogState() {
  Object.assign(sinkState, { hour: -1, chars: 0, dropped: 0 });
  sinkState.seen.clear();
}

/** Whether a line goes to Azure now, and how many repeats of it were held back since it last went. */
function admit(level: Level, chars: number, key: string, now: number): { send: boolean; repeats: number } {
  if (level === "info") {
    const hour = Math.floor(now / 3_600_000);
    if (hour !== sinkState.hour) {
      sinkState.hour = hour;
      sinkState.chars = 0;
    }
    if (sinkState.chars + chars > INFO_CHARS_PER_HOUR) {
      sinkState.dropped++;
      return { send: false, repeats: 0 };
    }
    sinkState.chars += chars;
    return { send: true, repeats: 0 };
  }
  const s = sinkState.seen.get(key);
  if (s && now - s.at < REPEAT_MS) {
    s.repeats++;
    return { send: false, repeats: 0 };
  }
  if (sinkState.seen.size > 300) sinkState.seen.clear();
  sinkState.seen.set(key, { at: now, repeats: 0 });
  return { send: true, repeats: s?.repeats ?? 0 };
}

const errText = (e: unknown) =>
  e instanceof Error ? [e.message, ...(e.stack ?? "").split("\n").slice(1, 6).map((l) => l.trim())].join(" | ") : String(e);

export async function log(env: Env, level: Level, event: string, f: LogFields = {}): Promise<void> {
  try {
    const run = runOf(env);
    const detail = redact([f.detail, f.err === undefined ? null : errText(f.err)].filter(Boolean).join(" | ")) || null;
    const row = { job: f.job ?? run.job ?? null, run_id: f.runId ?? run.runId ?? null, item_id: f.itemId ?? null, proposal_id: f.proposalId ?? null, ms: f.ms ?? null, detail };
    try {
      if (env.logSink) {
        const line = (extra: object) =>
          JSON.stringify({ ev: event, level, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)), ...extra }).slice(0, LINE_CHARS);
        const { send, repeats } = admit(level, line({}).length, `${level}|${event}|${f.itemId ?? ""}|${detail ?? ""}`, Date.now());
        if (send) env.logSink(level, line(repeats ? { repeats } : {}));
      }
    } catch {
      // Azure's logger failing must not stop the event below.
    }
    if (f.lineOnly) return;
    if (run.stored >= (level === "info" ? MAX_INFO_EVENTS : MAX_EVENTS)) {
      if (run.capped) return;
      run.capped = true;
      await env.store.jobs.addEvent(
        { kind: "log.capped", status: "warn", created_at: Date.now(), ...row, detail: "This run wrote as many events as one run may; the rest are only in Azure's logs." },
        TTL_S.warn,
      );
      return;
    }
    run.stored++;
    await env.store.jobs.addEvent({ kind: event.slice(0, 60), status: level, created_at: Date.now(), ...row }, TTL_S[level]);
  } catch {
    // Logging never breaks what it's logging.
  }
}

/** At the end of a run: how many lines were held back from Azure since the last report, if any. */
export function flushLog(env: Env): void {
  try {
    let repeats = 0;
    for (const s of sinkState.seen.values()) {
      repeats += s.repeats;
      s.repeats = 0;
    }
    if (!sinkState.dropped && !repeats) return;
    env.logSink?.("warn", JSON.stringify({ ev: "log.held_back", routine: sinkState.dropped, repeats }));
    sinkState.dropped = 0;
  } catch {
    // As above.
  }
}

/** Replaces `.catch(() => null)`: the failure is logged, and the caller carries on with null as before. */
export const swallow =
  (env: Env, event: string, f: Omit<LogFields, "err"> = {}) =>
  async (err: unknown): Promise<null> => {
    await log(env, "warn", event, { ...f, err });
    return null;
  };
